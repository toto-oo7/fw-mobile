/* ============================================================================
 * sw.js —— Service Worker
 * ============================================================================
 * 只做一件事：把界面文件缓存起来，让「添加到主屏幕」之后断网也能打开。
 *
 * ⚠⚠ 绝不缓存任何同步相关的请求（GitHub API / raw 原文）。
 *   缓存了就等于把待办数据留在缓存里，还会让「同步了但看到的还是旧的」。
 *   所以这类请求一律直接放行到网络。
 *
 * ⚠ 改了界面文件之后要**升版本号**（CACHE 里的 vN），否则用户手机上还是旧的。
 */
/* v3：底栏改成内联 SVG 图标 + 输入框钉底 + 底栏压矮（2026-10-15）
 * v4：合并的平局规则改成「删除优先；都不是墓碑时以云端为准」（2026-10-16）
 *     ⚠ 老规则「同 t 时本地赢」两端各留各的，永远收敛不了 → 必须让老客户端拿到新 records.js */
var CACHE = 'fw-mobile-v4';

var ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './records.js',
  './gist.js',
  './store.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // ⚠ 逐个 add，任何一个失败（比如某个图标还没生成）都不至于整个装不上
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 同步一律走网络，不进缓存
  // ⚠ api.github.com 和 raw.githubusercontent.com（>1MB 时走原文）都要放行
  if (url.hostname === 'api.github.com' ||
      url.hostname === 'raw.githubusercontent.com' ||
      url.hostname === 'gist.githubusercontent.com') {
    return;
  }
  // 别的站点也不管
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        // 后台顺手更新一份，下次打开就是新的（stale-while-revalidate）
        fetch(req).then(function (r) {
          if (r && r.ok) caches.open(CACHE).then(function (c) { c.put(req, r.clone()); });
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (r) {
        if (r && r.ok && r.type === 'basic') {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return r;
      }).catch(function () {
        // 离线且没缓存：导航请求兜底给首页
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504 });
      });
    })
  );
});
