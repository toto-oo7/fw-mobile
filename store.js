/* ============================================================================
 * store.js —— 手机端的状态 + 同步调度
 * ============================================================================
 *
 * 一次 sync() 的流程，和桌面端 `fw_sync.SyncEngine.sync()` **一一对应**：
 *
 *   读同步文件 → 本地摊平成记录 → 按记录合并 → 写回本地状态
 *   → 写回同步文件 → 对齐同步状态
 *
 * ⚠ 同步状态（每条记录「本机已知的最后修改时间」）存在**本机 localStorage**，
 *   绝不进同步文件 —— 那是「这台设备知道什么」，进去就会被对端覆盖。
 *
 * ⚠ 同步失败**不丢改动**：`collectLocal()` 是拿「当前内容」和「同步状态里记的内容」
 *   比出来的，失败时同步状态没有前进，所以下次成功时这些改动照样会被推上去。
 */
(function (global) {
  'use strict';

  var R = global.FWRecords;
  var GH = global.GH;

  var LS_STATE = 'fw.state.v1';
  var LS_SYNC = 'fw.syncstate.v1';
  var LS_CFG = 'fw.cfg.v1';

  var DEFAULT_CFG = {
    syncOn: false,
    theme: 'auto',              // auto | light | dark
    showDone: true,             // 待办里是否显示已完成
    lastBackupAt: ''            // 最近一次成功导出 / 分享备份的时间
  };

  /**
   * ⚠⚠ 「空默认值」判定 —— 和桌面端 `fw_sync._is_blank` **必须一致**。
   *
   * 场景：一台刚装好的手机，备忘是空的、顺序是空的、收起状态是 false。
   * 如果把这些也当成「本地刚改过」盖上新时间戳，它们就会**赢过**云端
   * —— 电脑上真写过的备忘、真拖过的顺序，被一台「什么都还没填」的手机一次同步冲掉。
   *
   * 关键区别：那台手机不是「用户把它清空了」，而是「还没同步过」。
   * 做法：第一次见到这个键、且值还是默认空 → 时间戳给 `''`（epoch 0），稳稳输给远端。
   */
  var BLANK_LIST_KEYS = { 'order:todos': 1, 'order:groups': 1 };

  function isBlank(key, d) {
    if (key.indexOf('cal:') === 0 || key.indexOf('order:cal:') === 0) {
      return Array.isArray(d) && d.length === 0;
    }
    if (BLANK_LIST_KEYS[key]) return Array.isArray(d) && d.length === 0;
    if (key === 'memo') return !!d && d.html === '' && d.updated === '';
    if (key === 'loose_collapsed') return !d;
    return false;
  }

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
    catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { return false; }
  }

  var Store = {
    state: R.emptyState(),
    syncState: { records: {}, at: '', gist: '' },
    cfg: Object.assign({}, DEFAULT_CFG),
    status: { ok: null, at: '', text: '还没同步过', pulled: 0 },
    busy: false,
    _subs: [],

    /* ------------------------------------------------------------ 生命周期 */

    load: function () {
      this.cfg = Object.assign({}, DEFAULT_CFG, lsGet(LS_CFG, {}));
      this.state = R.normalizeState(lsGet(LS_STATE, null));
      var ss = lsGet(LS_SYNC, null);
      this.syncState = (ss && typeof ss === 'object' && ss.records)
        ? ss : { records: {}, at: '', gist: '' };
      // ⚠ 换了 Gist 就等于「重新配对」：同步状态必须一起清掉。
      //   不清的话本机还记着「这些记录我早就知道了」，会把旧时间戳带进新配对，
      //   第一轮同步的行为就取决于上一条 Gist 的残留 —— 很难解释。
      var cur = (GH && GH.getCfg().gist) || '';
      if ((this.syncState.gist || '') !== cur) {
        this.syncState = { records: {}, at: '', gist: cur };
        this.saveSyncState();
      }
      return this;
    },

    saveCfg: function (patch) {
      Object.keys(patch || {}).forEach(function (k) { Store.cfg[k] = patch[k]; }, this);
      lsSet(LS_CFG, this.cfg);
      this.notify();
      return this.cfg;
    },

    saveState: function () { lsSet(LS_STATE, this.state); },

    saveSyncState: function () {
      this.syncState.gist = (GH && GH.getCfg().gist) || '';
      lsSet(LS_SYNC, this.syncState);
    },

    /* ------------------------------------------------------------ 订阅 */

    subscribe: function (fn) { this._subs.push(fn); },
    notify: function () {
      var self = this;
      this._subs.forEach(function (f) {
        try { f(self); } catch (e) { console.error('[store] 订阅者出错', e); }
      });
    },

    /**
     * 改状态的标准入口：改完落盘 + 通知界面。
     * ⚠ 时间戳不用手动盖 —— 同步时 `collectLocal()` 会拿内容摘要比对，
     *   发现变了才盖新时间。这样「改了又改回去」不会留下无谓的改动。
     */
    mutate: function (fn) {
      fn(this.state);
      this.state = R.normalizeState(this.state);
      this.saveState();
      this.notify();
    },

    /* ------------------------------------------------------------ 摊平 */

    /** 对应桌面端 `SyncEngine._collect_local`。 */
    collectLocal: function () {
      var raw = R.recordsFromState(this.state);
      var st = this.syncState.records;
      var now = R.nowIso();
      var out = {};

      Object.keys(raw).forEach(function (k) {
        var h = R.hashOf(raw[k]);
        var s = st[k];
        if (!s || s.h !== h) {
          // ⚠ 第一次见到、且还是默认空值 → 时间戳留空（见 `isBlank` 的注释），
          //   否则一台空白手机会把云端的真内容冲掉。
          var ts = (!s && isBlank(k, raw[k])) ? '' : now;
          st[k] = { t: ts, x: false, h: h };
          out[k] = { d: raw[k], t: ts, x: false };
        } else {
          // ⚠ 不能写 `s.t || now` —— `''` 会被 `||` 吞掉又变成 now，
          //   于是「空白记录」在第二次同步时突然变得能赢，问题只是延后一轮。
          out[k] = { d: raw[k], t: (s.t === undefined ? now : s.t), x: !!s.x };
        }
      });
      Object.keys(st).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(raw, k)) return;
        if (!st[k].x) {
          st[k] = { t: now, x: true, h: null };
          out[k] = { d: null, t: now, x: true };
        } else {
          out[k] = { d: null, t: st[k].t || now, x: true };
        }
      });
      return out;
    },

    /** 对应桌面端 `SyncEngine._refresh_state`。 */
    refreshState: function (merged) {
      var raw = R.recordsFromState(this.state);
      var st = {};
      Object.keys(merged).forEach(function (k) {
        var r = merged[k];
        if (r.x) st[k] = { t: r.t, x: true, h: null };
        else if (Object.prototype.hasOwnProperty.call(raw, k)) {
          st[k] = { t: r.t, x: false, h: R.hashOf(raw[k]) };
        }
      });
      this.syncState.records = st;
      this.syncState.at = R.nowIso();
    },

    /* ------------------------------------------------------------ 同步 */

    /**
     * 同步**压根没跑起来**（没开开关 / 没填 Token）也要记进状态。
     * ⚠ 不记的话，界面上只会说「还没同步过」，用户不知道为什么点不动。
     */
    _reject: function (msg) {
      this.status = { ok: false, at: R.stamp(), text: '', pulled: 0, error: msg };
      this.notify();
      return Promise.reject(new Error(msg));
    },

    sync: function (opts) {
      opts = opts || {};
      var self = this;
      if (!this.cfg.syncOn) {
        return this._reject('同步没打开');
      }
      if (this.busy) return Promise.resolve(this.status);
      if (!GH.isSignedIn()) {
        return this._reject('还没连接 GitHub（设置 → 同步设置里填 Token）');
      }
      this.busy = true;
      this.status = { ok: null, at: R.stamp(), text: '正在同步…', pulled: 0 };
      this.notify();

      return Promise.resolve()
        // ⚠ 没填 Gist 地址就自动建一个**私密** Gist（和桌面端 `_ensure_gist` 一致），
        //   省掉「先去 GitHub 建一个再抄地址」这一步。建完地址会落进本机配置。
        .then(function () { return GH.getCfg().gist ? null : GH.createGist(); })
        .then(function () { return self._syncOnce(0); })
        .then(function (res) {
          self.busy = false;
          self.status = res;
          self.notify();
          return res;
        }).catch(function (e) {
          self.busy = false;
          self.status = { ok: false, at: R.stamp(), text: '', pulled: 0, error: String(e.message || e) };
          self.notify();
          throw e;
        });
    },

    /** 真正跑一轮。`attempt` 用来做「写冲突 → 重读重合并」的重试。 */
    _syncOnce: function (attempt) {
      var self = this;

      return GH.readFile().then(function (rf) {
        var remote = {};
        var doc = null;
        if (rf.text) {
          try { doc = JSON.parse(rf.text); } catch (e) { doc = null; }
          if (doc && doc.records && typeof doc.records === 'object') remote = doc.records;
        }

        var local = self.collectLocal();
        var merged = R.gcTombstones(R.mergeRecords(local, remote));

        // 这次实际从云端拉回来几条（远端比本地新的）
        var pulled = 0;
        Object.keys(merged).forEach(function (k) {
          var lr = local[k], r = merged[k];
          if (lr === undefined) { pulled++; return; }
          var tr = R.ts(r.t || ''), tl = R.ts(lr.t || '');
          if (tr > tl) pulled++;
          else if (tr === tl && !!r.x !== !!lr.x) pulled++;
        });

        // 应用到本地状态
        var before = R.hashOf(R.recordsFromState(self.state));
        self.state = R.applyRecordsToState(self.state, merged);
        var after = R.hashOf(R.recordsFromState(self.state));
        if (before !== after) self.saveState();

        var out = {
          schema: R.SCHEMA,
          updated_at: R.nowIso(),
          records: merged
        };

        return GH.writeFile(JSON.stringify(out, null, 2)).then(function (w) {
          if (w.conflict && attempt < 2) {
            // ⚠ 另一端在我们读完之后又写了 → 重读一遍重新合并，别硬盖。
            //   Gist 的 PATCH 没有条件写，所以 `conflict` 目前永远是 false；
            //   这条分支留着，是为了将来换回有条件写的通道时不用改这里。
            return self._syncOnce(attempt + 1);
          }
          self.refreshState(merged);
          self.saveSyncState();
          return {
            ok: true, at: R.stamp(), pulled: pulled, total: Object.keys(merged).length,
            changed: before !== after, text: '', conflict: !!w.conflict
          };
        });
      });
    },

    /* ------------------------------------------------------------ 备份 */

    exportJson: function () {
      return JSON.stringify({
        kind: '小浮窗数据', schema: R.SCHEMA, exported_at: R.nowIso(), state: this.state
      }, null, 2);
    },

    importJson: function (text) {
      var j = JSON.parse(text);
      var st = j && j.state ? j.state : j;      // 也允许直接给一个裸状态
      this.mutate(function (s) {
        var n = R.normalizeState(st);
        s.todos = n.todos; s.groups = n.groups; s.cal = n.cal;
        s.memo_html = n.memo_html; s.memo_updated = n.memo_updated;
        s.loose_collapsed = n.loose_collapsed;
      });
      return this.state;
    },

    wipe: function () {
      this.state = R.emptyState();
      this.syncState = { records: {}, at: '', gist: (GH && GH.getCfg().gist) || '' };
      this.saveState();
      this.saveSyncState();
      this.notify();
    }
  };

  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
