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
 *     ⚠ 老规则「同 t 时本地赢」两端各留各的，永远收敛不了 → 必须让老客户端拿到新 records.js
 * v5：待办加了 done_at（完成日期）。日历上多一个灰点 = 这天划掉过东西（2026-10-16）
 *     ⚠ 老客户端不认识这个字段，一勾选就会把它推没 → 必须让它们拿到新 records.js
 * v6：底部标签栏改成「钉在视口底部 + 内容居中」（2026-10-16）
 *     ⚠ 改的是 app.css：老客户端缓存着旧样式，白条下方会一直露一截
 * v7：新版装好后**自动刷一次页面** + 设置页显示「界面版本」（2026-10-16）
 *     ⚠ 病根：stale-while-revalidate 让**打开那一瞬间还是旧界面**，要下次打开才变
 *       → 每次改完 toto 都以为「没推上去」。现在 controllerchange 后自动 reload。
 * v8：★★ 界面文件从 stale-while-revalidate 改成 **network-first**（2026-10-17）
 *     ⚠⚠ v7 没治好，因为它只解决了「装好了但没刷」。真正的坑在**装的那一刻抓的是什么**：
 *       install 用 `cache:'reload'` 只能绕过**浏览器**缓存，绕不过 **GitHub Pages 的 CDN**
 *       （Fastly 边缘，实测推送后约 1 分钟还是旧副本）。
 *       于是：推送 → 1 分钟内打开 → 新版本缓存里存进了**旧 CSS** → 之后每次打开都命中它
 *       → 用户看到的一直是「上一次 install 的快照」，而且**设置页显示的版本号是对的**
 *       （版本号读的是缓存名，只能证明 SW 是 v7，证明不了 app.css 是新的）。
 *     → 现在同源 GET 一律**先走网络**（`cache:'no-cache'` 强制回源验证，没变就 304 不重传），
 *       只有**网络失败（真离线）**才回退缓存。代价是每次打开多一次条件请求，几十毫秒。
 *       换来的是：**改完打开一次就是新版**，不用关掉重开、不用等下一次。
 */
/* v17：电脑 / 手机统一视觉；卡片层级、日历、底栏和深色主题精修（2026-10-21） */
var CACHE = 'fw-mobile-v21-soft-yellow';

var ASSETS = [
  './',
  './index.html',
  './app.css',
  './SourceCodePro-Variable.woff2',
  './app.js',
  './records.js',
  './gist.js',
  './cloud-config.js',
  './supabase.js',
  './account.js',
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

  // ★★ 同源界面文件：**网络优先**（v8，2026-10-17）
  //   为什么不再用 stale-while-revalidate：
  //     它永远先给缓存，于是「改完打开」看到的永远是**上次 install 的快照**。
  //     再叠上 GitHub Pages 的 CDN 延迟，快照很可能就是旧文件 → 表现成「改了没生效」。
  //   `cache: 'no-cache'` = 允许用浏览器缓存，但**必须先回服务器验证**（ETag → 304 不重传 body）。
  //   所以在线时拿到的一定是最新文件，流量也没浪费。
  //   只有 fetch 直接失败（真离线 / DNS 挂了）才回退缓存。
  var fresh;
  try {
    fresh = new Request(req, { cache: 'no-cache' });
  } catch (err) {
    fresh = req;
  }
  e.respondWith(
    fetch(fresh).then(function (r) {
      if (r && r.ok && r.type === 'basic') {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return r;
    }).catch(function () {
      // 离线：吃缓存（这就是「装到主屏也能开」的来源）
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504 });
      });
    })
  );
});
