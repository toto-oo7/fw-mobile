/* ============================================================================
 * gist.js —— 手机端访问 GitHub 私密 Gist 的通道
 * ============================================================================
 *
 * 只做两件事：拿一个 Token 换一个 Gist，然后读写 Gist 里的一个文件。
 *
 * ── 为什么是 Gist（2026-10-15 定了这条）────────────────────────────────────
 * 需求是 `免注册 + 双向可写 + 浏览器能读(CORS) + 持久 + 容量够`。
 * 实测了 12 个「免注册中转」服务，**没有一条同时满足**（详见双端同步方案.md）。
 * GitHub 是唯一同时满足的：一个免费账号 + 一个只勾 Gists 权限的 Token，
 * 不要银行卡，`api.github.com` 实测带 `Access-Control-Allow-Origin: *`
 * 且预检允许 `GET/PATCH` + `Authorization` —— **手机浏览器能直接读写**。
 *
 * ── 和旧版 onedrive.js 的关系 ──────────────────────────────────────────────
 * 对外的四个方法（`isSignedIn` / `readFile` / `writeFile` / `getCfg`）签名**完全没变**，
 * 所以 `store.js` 里除了名字，合并逻辑一行都不用动。原来那条 Azure/Graph 的路
 * 需要注册应用 + 绑卡，已经废弃（文件也删了）。
 *
 * ── ⚠ 为什么没有乐观锁（旧版有 If-Match）──────────────────────────────────
 * Graph 支持 `If-Match` + 412 冲突；Gist 的 PATCH **没有**条件写。
 * 但这不是问题，因为两端的合并设计本来就是**自愈**的：
 * 每次同步双方都发布「自己的全量记录」，万一有一边被盖掉，
 * 它下一次同步会把自己的记录再发一遍，按 `t` 比大小就自动恢复了。
 * 所以这里不需要（也没法）加乐观锁 —— 和桌面端 `fw_sync.GistStore` 行为一致。
 *
 * ⚠ 一次同步 = 2 个请求（1 次 GET 读 + 1 次 PATCH 写）。
 *   为了做「写前检查版本」再插一次 GET 不划算：Gist 的 GET 会把整个文件内容
 *   一起返回（没有字段选择器），等于把 40KB 再下载一遍。
 */
(function (global) {
  'use strict';

  var API = 'https://api.github.com';
  var LS_CFG = 'fw.gh.cfg.v1';

  // ⚠ 这个文件名必须和桌面端 `fw_sync.SYNC_FILE` 一字不差（含中文）
  var FILE = '浮窗同步.json';
  // ⚠ Gist 的文件超过 1MB 时，API 只给半截 `content` + `truncated: true`
  //   （要另走 raw_url）。我们正常远小于 1MB，但真到了那天不能静默拿半截 JSON。
  var TRUNC_LIMIT = 1024 * 1024;

  /* ---------------------------------------------------------------- 小工具 */

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
    catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { return false; }          // 隐私模式 / 配额满
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function getCfg() {
    return lsGet(LS_CFG, { token: '', gist: '', user: '' });
  }
  function setCfg(patch) {
    var c = getCfg();
    Object.keys(patch || {}).forEach(function (k) { c[k] = patch[k]; });
    lsSet(LS_CFG, c);
    return c;
  }

  /* ---------------------------------------------------------------- 请求 */

  /**
   * 把 GitHub 的 HTTP 错误翻成一句人话。
   * ⚠ 文案要和桌面端 `fw_sync._gh_msg` 保持一致 —— 同一件事在两处说不一样的话很恼人。
   */
  function ghMsg(status, j, text) {
    var m = (j && j.message) || '';
    if (status === 401) return 'Token 无效或已过期 —— 去 GitHub 重新生成一个';
    if (status === 403) {
      return 'GitHub 拒绝了：多半是 Token 没勾「Gists」权限，或者触发了限流';
    }
    if (status === 404) return '找不到这个 Gist（地址抄错了，或者 Token 看不到它）';
    if (status === 422) return 'GitHub 说数据有问题：' + m;
    return 'GitHub 返回 HTTP ' + status + '：' + (m || String(text || '').slice(0, 100));
  }

  /**
   * 发一个请求。
   * ⚠ 网络层失败（断网 / 被墙 / DNS）和 HTTP 业务错误要分开报 ——
   *   前者要说「连不上」，后者要说「GitHub 说了什么」。
   */
  function req(method, path, body) {
    var cfg = getCfg();
    if (!cfg.token) {
      return Promise.reject(new Error('还没填 GitHub Token（设置 → 同步设置）'));
    }
    var opts = {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(body);
    }
    return fetch(API + path, opts).catch(function (e) {
      // fetch 只在网络层出错时 reject；HTTP 4xx/5xx 是 resolve 的
      throw new Error('连不上 GitHub（检查网络）：' + (e && e.message ? e.message : e));
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) { /* 可能是空体或 HTML 错误页 */ }
        if (!r.ok) throw new Error(ghMsg(r.status, j, txt));
        return j;
      });
    });
  }

  /* ---------------------------------------------------------------- 通道 */

  function isSignedIn() { return !!getCfg().token; }

  /**
   * 设置页里显示「已连接：toto-oo7」。
   * ⚠ 这是**同步返回缓存值**，不是 Promise —— 设置页在拼 HTML 字符串时没法 await。
   *   登录名由 `verify()` 拿回来并缓存；没缓存过就先显示个「已连接」。
   */
  function account() {
    var c = getCfg();
    if (!c.token) return '';
    return c.user || '已连接';
  }

  /** 验证 Token 能不能用，顺便把登录名取回来缓存。 */
  function verify() {
    return req('GET', '/user').then(function (u) {
      var who = (u && (u.login || u.name)) || '已连接';
      setCfg({ user: who });
      return who;
    });
  }

  /**
   * 新建一个**私密** Gist，返回它的 id。
   * ⚠ 顺带塞一份空文档进去 —— 这样两端第一次读都有东西可读，不会把「文件不存在」
   *   和「还没同步过」混起来。
   */
  function createGist() {
    var body = {
      description: '小浮窗双端同步（程序自动读写，请不要手动编辑）',
      public: false,                       // false = 私密（别人搜不到）
      files: {}
    };
    body.files[FILE] = {
      content: JSON.stringify({ schema: 1, updated_at: new Date().toISOString(), records: {} },
        null, 2)
    };
    return req('POST', '/gists', body).then(function (j) {
      if (!j || !j.id) throw new Error('GitHub 没返回 Gist 地址');
      setCfg({ gist: j.id });
      return j.id;
    });
  }

  function gistUrl() {
    var g = getCfg().gist;
    return g ? ('https://gist.github.com/' + g) : '';
  }

  /**
   * 读同步文档。返回 `{text, eTag, missing}`。
   * ⚠ 与旧版签名一致（`eTag` 现在填的是版本号，但调用方不用它做条件写）。
   * ⚠ Gist 还没建 / 文件不存在 → `missing: true`，**不是错误**：首次同步本来就还没有。
   */
  function readFile() {
    var cfg = getCfg();
    if (!cfg.token) {
      return Promise.reject(new Error('还没填 GitHub Token（设置 → 同步设置）'));
    }
    if (!cfg.gist) return Promise.resolve({ text: '', eTag: '', missing: true });

    return req('GET', '/gists/' + encodeURIComponent(cfg.gist)).then(function (j) {
      var files = (j && j.files) || {};
      var ent = files[FILE] || files[Object.keys(files)[0]];
      if (!ent) return { text: '', eTag: '', missing: true };
      var txt = ent.content || '';
      var ver = ((j.history || [])[0] || {}).version || '';
      if (ent.truncated || txt.length >= TRUNC_LIMIT) {
        // ⚠ 超过 1MB 时 GitHub 只给半截 content，必须走 raw_url，否则静默丢数据
        if (ent.raw_url) {
          return fetch(ent.raw_url).then(function (r) { return r.text(); })
            .then(function (full) {
              return { text: full, eTag: ver, missing: false };
            });
        }
      }
      return { text: txt, eTag: ver, missing: false };
    }, function (e) {
      // ⚠ 404 在这里是「Gist 被删了 / 地址抄错」，当成 missing 会让用户以为是首次同步
      //   然后把本地数据推上去、凭空建出一个孤儿 Gist。所以照实报错。
      if (/404/.test(String(e.message || ''))) {
        return Promise.reject(new Error(
          '这个 Gist 找不到了 —— 地址可能抄错，或者它已经被删了。' +
          '去设置里清空「Gist 地址」，下次同步会自动新建一个。'));
      }
      throw e;
    });
  }

  /**
   * 写同步文档。返回 `{conflict, eTag, name}`。
   * ⚠ `conflict` 永远是 false —— 见文件头「为什么没有乐观锁」。
   */
  function writeFile(text) {
    var cfg = getCfg();
    if (!cfg.gist) {
      return Promise.reject(new Error('还没建 Gist —— 去设置里点「新建」'));
    }
    var body = { files: {} };
    body.files[FILE] = { content: text };
    return req('PATCH', '/gists/' + encodeURIComponent(cfg.gist), body).then(function (j) {
      var ver = ((j && j.history) || [])[0] || {};
      return { conflict: false, eTag: ver.version || '', name: FILE };
    });
  }

  /** 断开：只清本机的 Token / Gist 地址，不动 GitHub 上的东西。 */
  function signOut() { lsDel(LS_CFG); }

  global.GH = {
    FILE: FILE,
    getCfg: getCfg, setCfg: setCfg,
    isSignedIn: isSignedIn, account: account, verify: verify,
    createGist: createGist, gistUrl: gistUrl,
    readFile: readFile, writeFile: writeFile, signOut: signOut
  };
})(typeof window !== 'undefined' ? window : globalThis);
