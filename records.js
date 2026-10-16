/* ============================================================================
 * records.js —— 记录模型
 * ============================================================================
 *
 * ⚠⚠ 这个文件是桌面端 `fw_sync.py` 的**逐字移植**。两边必须给出完全一样的
 *     摊平结果、合并结果、墓碑判定 —— 否则手机和电脑会把彼此的数据改坏。
 *     改这里之前，先改 fw_sync.py，再回来同步改，然后跑 `node test/records.test.js`。
 *
 * 同步文件长这样（schema 1）：
 *   { "schema": 1, "updated_at": "...", "records": { "<键>": {d, t, x} } }
 *   · d = 内容，t = 最后修改时间（ISO8601 带时区），x = 墓碑（true 表示「这条被删了」）
 *   · 键的形状：memo / loose_collapsed / todo:<id> / group:<id> / cal:<YYYY-MM-DD>
 *               + 顺序记录 order:todos / order:groups / order:cal:<日期>
 *
 * ⚠ 顺序**单独成记录**，不给每条加 sort 字段 —— 桌面端的数组顺序本来就是权威顺序
 *   （拖动结束后会按「分组顺序 + 未分组」整体重建）。这样两端都不用动排序代码。
 *
 * ⚠ 配置（窗口位置/分栏/主题/字号/代理/API Key）**不同步**，那是设备相关的，
 *   而且密钥根本不该离开本机。白名单在 `recordsFromState` 里，只取已知数据字段。
 */
(function (global) {
  'use strict';

  var SCHEMA = 1;
  var SYNC_FILE = '浮窗同步.json';
  var TOMBSTONE_DAYS = 30;

  /* ---------------------------------------------------------------- 时间 */

  /**
   * 本地时区的 ISO8601，毫秒精度 —— 形状与 Python 的
   * `datetime.now().astimezone().isoformat(timespec='milliseconds')` 一致。
   *
   * ⚠ 精度必须到毫秒：合并靠「t 谁大谁赢」，秒精度下同一秒内的两次改动会拿到
   *   完全相同的字符串，于是退化成「删除优先」的平局规则，后改的那次会被丢掉。
   */
  function nowIso() {
    var d = new Date();
    function p(n, w) { return String(n).padStart(w || 2, '0'); }
    var off = -d.getTimezoneOffset();          // 分钟，东八区 = +480
    var sign = off >= 0 ? '+' : '-';
    var a = Math.abs(off);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      '.' + p(d.getMilliseconds(), 3) +
      sign + p(Math.floor(a / 60)) + ':' + p(a % 60);
  }

  /** 「10-15 18:22」这种给人看的时间戳（和桌面端一致）。 */
  function stamp(d) {
    d = d || new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * ISO8601 → epoch 毫秒。
   *
   * ⚠⚠ 不能拿时间戳字符串直接比大小：两台设备时区不同时字符串序 ≠ 时间序。
   *   例：+08:00 的「20:00+08:00」= 12:00 UTC，+00:00 的「13:00+00:00」= 13:00 UTC，
   *   后者才晚 —— 但字符串上前者大。手机可能在任何时区，所以一律按瞬时比。
   * ⚠ 解析不了返回 0（当最老），绝不让一条脏数据把整个合并搞崩。
   */
  function ts(s) {
    var n = Date.parse(s || '');
    return isNaN(n) ? 0 : n;
  }

  /* ---------------------------------------------------------------- 摘要 */

  /** 规范化 JSON：键递归排序、无空格 —— 只为「内容变没变」服务。 */
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + canonical(v[k]);
    }).join(',') + '}';
  }

  /**
   * 内容摘要（16 位十六进制）。
   *
   * ⚠ 这个值**只存在本机的同步状态里**，绝不写进同步文件 ——
   *   所以它不需要和 Python 的 sha1 一样，只要本机稳定即可。
   *   两条 32 位哈希拼成 64 位，160 条记录撞车概率约 1e-15，可以忽略。
   */
  function hashStr(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + c) >>> 0; h2 = Math.imul(h2 ^ (h2 >>> 13), 0x5bd1e995) >>> 0;
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') +
      (h2 >>> 0).toString(16).padStart(8, '0');
  }

  function hashOf(v) { return hashStr(canonical(v)); }

  /* ---------------------------------------------------------------- 状态 */

  /** 空状态。字段名和桌面端 `小浮窗数据.json` 完全一致。 */
  function emptyState() {
    return {
      todos: [],            // [{id, text, done, star, group}]
      groups: [],           // [{id, name, collapsed}]
      cal: {},              // { 'YYYY-MM-DD': [{id, text, group, done}] }
      memo_html: '',
      memo_updated: '',
      loose_collapsed: false
    };
  }

  /** 补齐缺失字段（从老数据/半截数据里读出来的东西）。 */
  function normalizeState(st) {
    var s = st && typeof st === 'object' ? st : {};
    var out = emptyState();
    out.todos = (Array.isArray(s.todos) ? s.todos : []).filter(function (t) {
      return t && t.id;
    }).map(function (t) {
      return {
        id: String(t.id), text: String(t.text || ''),
        done: !!t.done, star: Math.max(0, Math.min(3, parseInt(t.star, 10) || 0)),
        group: String(t.group || ''),
        done_at: String(t.done_at || '')
      };
    });
    out.groups = (Array.isArray(s.groups) ? s.groups : []).filter(function (g) {
      return g && g.id;
    }).map(function (g) {
      return { id: String(g.id), name: String(g.name || ''), collapsed: !!g.collapsed };
    });
    var cal = s.cal && typeof s.cal === 'object' ? s.cal : {};
    Object.keys(cal).forEach(function (day) {
      var lst = Array.isArray(cal[day]) ? cal[day] : [];
      var items = lst.filter(function (x) { return x && x.id; }).map(function (x) {
        return {
          id: String(x.id), text: String(x.text || ''),
          group: String(x.group || ''), done: !!x.done
        };
      });
      if (items.length) out.cal[day] = items;
    });
    out.memo_html = String(s.memo_html || '');
    out.memo_updated = String(s.memo_updated || '');
    out.loose_collapsed = !!s.loose_collapsed;
    return out;
  }

  /** 新建一个 id。⚠ 和桌面端一样是 12 位十六进制，够用且短。 */
  function newId() {
    var b = new Uint8Array(6);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(b);
    } else {
      for (var i = 0; i < 6; i++) b[i] = Math.floor(Math.random() * 256);
    }
    return Array.prototype.map.call(b, function (x) {
      return x.toString(16).padStart(2, '0');
    }).join('');
  }

  /* ---------------------------------------------------------- 状态 → 记录 */

  /**
   * 把状态摊平成记录（**只取数据字段**）。
   *
   * ⚠ 这里就是那道白名单：主题、窗口位置、代理、API Key 根本不会出现在状态里；
   *   将来状态里多出字段也不会被自动带上（要同步就得显式加到这里）。
   */
  function recordsFromState(st) {
    var s = normalizeState(st);
    var out = {};

    out['memo'] = { html: s.memo_html || '', updated: s.memo_updated || '' };
    out['loose_collapsed'] = !!s.loose_collapsed;

    s.todos.forEach(function (t) {
      out['todo:' + t.id] = {
        text: t.text || '', done: !!t.done,
        star: t.star || 0, group: t.group || '',
        // ⚠ 完成日期必须带上 —— 和桌面端 `records_from_dat` 的白名单一一对应，
        //   漏了就是「手机一勾选、桌面日历上的灰圈就没了」，而且不报错。
        done_at: t.done_at || ''
      };
    });
    out['order:todos'] = s.todos.map(function (t) { return t.id; });

    s.groups.forEach(function (g) {
      out['group:' + g.id] = { name: g.name || '', collapsed: !!g.collapsed };
    });
    out['order:groups'] = s.groups.map(function (g) { return g.id; });

    Object.keys(s.cal).forEach(function (day) {
      var items = s.cal[day] || [];
      out['cal:' + day] = items.map(function (x) {
        return { id: x.id, text: x.text || '', group: x.group || '', done: !!x.done };
      });
      out['order:cal:' + day] = items.map(function (x) { return x.id; });
    });

    return out;
  }

  /**
   * 按顺序记录排。**顺序里没有的 id 保持在原位排到最后**。
   *
   * ⚠ 必须容错：另一台设备刚新建的条目还没来得及并进顺序记录，
   *   不能因此让它从列表里消失。
   */
  function orderKeep(ids, order) {
    var seen = {}, out = [];
    ids.forEach(function (i) { seen[i] = true; });
    (order || []).forEach(function (i) {
      if (seen[i] && out.indexOf(i) < 0) out.push(i);
    });
    ids.forEach(function (i) { if (out.indexOf(i) < 0) out.push(i); });
    return out;
  }

  /* ---------------------------------------------------------- 记录 → 状态 */

  /** 把合并后的记录写回状态。**返回新对象**（手机端不做就地改，方便撤销/比较）。 */
  function applyRecordsToState(st, rec) {
    var s = normalizeState(st);
    var live = {};
    Object.keys(rec || {}).forEach(function (k) {
      var r = rec[k];
      if (r && !r.x) live[k] = r;
    });

    var m = live['memo'];
    if (m !== undefined) {
      var md = m.d || {};
      s.memo_html = String(md.html || '');
      s.memo_updated = String(md.updated || '');
    }
    if (live['loose_collapsed'] !== undefined) {
      s.loose_collapsed = !!live['loose_collapsed'].d;
    }

    // ---- 分组
    var gids = Object.keys(live).filter(function (k) {
      return k.indexOf('group:') === 0;
    }).map(function (k) { return k.slice(6); });
    gids = orderKeep(gids, (live['order:groups'] || {}).d);
    s.groups = gids.map(function (g) {
      var d = (live['group:' + g] || {}).d || {};
      return { id: g, name: String(d.name || ''), collapsed: !!d.collapsed };
    });

    // ---- 待办
    var tids = Object.keys(live).filter(function (k) {
      return k.indexOf('todo:') === 0;
    }).map(function (k) { return k.slice(5); });
    tids = orderKeep(tids, (live['order:todos'] || {}).d);
    s.todos = tids.map(function (i) {
      var d = (live['todo:' + i] || {}).d || {};
      return {
        id: i, text: String(d.text || ''), done: !!d.done,
        star: parseInt(d.star, 10) || 0, group: String(d.group || ''),
        // 老记录没有这个字段 → 补空串，形状和本地新建的一致
        done_at: String(d.done_at || '')
      };
    });

    // ---- 日历
    var cal = {};
    Object.keys(live).forEach(function (k) {
      if (k.indexOf('cal:') !== 0) return;
      var day = k.slice(4);
      var items = Array.isArray(live[k].d) ? live[k].d : [];
      var byid = {};
      items.forEach(function (x) {
        if (x && x.id) {
          byid[x.id] = {
            id: String(x.id), text: String(x.text || ''),
            group: String(x.group || ''), done: !!x.done
          };
        }
      });
      var ids = orderKeep(Object.keys(byid), (live['order:cal:' + day] || {}).d);
      cal[day] = ids.map(function (i) { return byid[i]; });
    });
    s.cal = cal;
    return s;
  }

  /* ---------------------------------------------------------------- 合并 */

  /**
   * 记录级 last-write-wins。
   *   · t 新的赢（后改的赢）—— ⚠ 按瞬时比，不按字符串
   *   · t 相同时**删除优先** —— ⚠ 反过来会出现「我明明删了它又自己回来了」，更恼火
   */
  function mergeRecords(local, remote) {
    var out = {}, keys = {};
    Object.keys(local || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(remote || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var a = (local || {})[k], b = (remote || {})[k];
      if (a === undefined) { out[k] = b; return; }
      if (b === undefined) { out[k] = a; return; }
      var ta = ts(a.t || ''), tb = ts(b.t || '');
      if (ta > tb) out[k] = a;
      else if (tb > ta) out[k] = b;
      // ⚠⚠ 平局（t 相同）的裁决必须**两端算出同一个结果**，否则永远收敛不了。
      //   原来是「本地赢」—— 两台设备各留各的、各自再推上去，每轮互相覆盖一次。
      //   现在：删除优先；都不是墓碑时**以远端（云端）为准**。
      //   ⚠ 桌面端 `fw_sync.merge_records` 必须同步改成一样的规则（夹具同时驱动两侧）。
      else if (a.x || b.x) out[k] = a.x ? a : b;
      else out[k] = b;
    });
    return out;
  }

  /** 清掉过期墓碑。⚠ 截止时间要和 nowIso() 同精度，否则边界那一天比较会串。 */
  function gcTombstones(rec, days) {
    var cut = Date.now() - (days || TOMBSTONE_DAYS) * 86400000;
    var out = {};
    Object.keys(rec || {}).forEach(function (k) {
      var v = rec[k];
      if (v && v.x && ts(v.t || '') < cut) return;
      out[k] = v;
    });
    return out;
  }

  /* ---------------------------------------------------------------- 自测 */

  /** 把上面几个纯函数挂出去，供浏览器和 node 测试共用。 */
  global.FWRecords = {
    SCHEMA: SCHEMA, SYNC_FILE: SYNC_FILE, TOMBSTONE_DAYS: TOMBSTONE_DAYS,
    nowIso: nowIso, stamp: stamp, ts: ts, canonical: canonical,
    hashStr: hashStr, hashOf: hashOf,
    emptyState: emptyState, normalizeState: normalizeState, newId: newId,
    recordsFromState: recordsFromState, applyRecordsToState: applyRecordsToState,
    orderKeep: orderKeep, mergeRecords: mergeRecords, gcTombstones: gcTombstones
  };
})(typeof window !== 'undefined' ? window : globalThis);
