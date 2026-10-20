/* ============================================================================
 * app.js —— 手机版界面逻辑
 * ============================================================================
 *
 * 结构：纯手写 DOM，没有框架、没有构建步骤 —— 一个静态站点，扔哪儿都能跑。
 *
 * ⚠ 两条贯穿全局的规矩：
 *   1. **一切改动都走 `Store.mutate()`**。它负责落盘 + 通知界面；
 *      时间戳不手动盖，交给同步时按内容摘要判断（改了又改回去不留痕）。
 *   2. **渲染只重画当前那一页**。否则用户在输入框里打字时被重画，光标就飞了。
 *
 * 通道是 GitHub 私密 Gist（`gist.js`，全局名 `GH`）—— 手机浏览器能直连读写，
 * 只要一个 Token，不要注册应用、不要银行卡。
 */
(function () {
  'use strict';

  var R = window.FWRecords;
  var S = window.Store;
  var GH = window.GH;

  /* ★★ 界面代码的「构建号」—— **写死在这里**，每次改界面就改一下（2026-10-17 加）。
     为什么不能只靠 SW 的缓存名（v7/v8…）：那个只证明 **Service Worker 是新的**，
     证明不了**页面实际加载的 app.css / app.js 是新的** ——
     页面完全可能是「新 SW + 旧缓存快照」。所以诊断必须同时给出：
       ① 这行常量  → 证明 app.js 是新的
       ② #tabs 的 computed position → 证明 app.css 是新的（旧版是 static，v8 起是 fixed）
       ③ 底栏底 / 视口高 → 直接量「到底贴没贴底」，不靠肉眼判断 */
  var APP_BUILD = 'b13';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var ui = {
    tab: 'todo',
    sortMode: false,
    calY: 0, calM: 0,
    memoDirty: false,
    memoFocus: false,
    memoSaved: '',           // 上一次写进 store 的纯文本，用来判断「真的改了没」
    newTodoGroup: '',        // 新建待办/备注默认归到哪个分组（记住上次选的）
    lastSync: 0              // 上次同步的时刻，用来给「回到前台自动同步」节流
  };

  /* ---------------------------------------------------------------- 工具 */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('on'); }, ms || 2200);
  }

  function stars(n) {
    n = parseInt(n, 10) || 0;
    return n <= 0 ? '○' : new Array(n + 1).join('●');
  }

  /* ------------------------------------------------------------ 弹层 */

  var sheetClose = null;

  function openSheet(html, onMount) {
    var sh = $('#sheet');
    $('#sheet-body').innerHTML = html;
    sh.classList.add('on');
    $('#scrim').classList.add('on');
    sheetClose = function () {
      sh.classList.remove('on');
      $('#scrim').classList.remove('on');
      sheetClose = null;
    };
    if (onMount) onMount($('#sheet-body'));
  }

  function closeSheet() { if (sheetClose) sheetClose(); }

  $('#scrim').addEventListener('click', closeSheet);

  /* ------------------------------------------------- 备忘录：HTML ↔ 纯文本 */

  /**
   * 桌面端的备忘是 QTextEdit 的 `toHtml()`（一整个 HTML 文档），
   * 手机上直接编辑 HTML 不现实 —— 这里摊成纯文本。
   *
   * ⚠⚠ 代价要说清楚：**手机上改备忘会把电脑端的粗体/颜色等格式压成纯文本**。
   *     所以只在用户真的动过输入框时才写回（见 memoDirty）。
   */
  var BLOCK = { P: 1, DIV: 1, LI: 1, TR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, PRE: 1, BLOCKQUOTE: 1 };
  // 这些是「装着块级元素的容器」，用来判断空白文本节点要不要丢
  var BLOCKBOX = {
    P: 1, DIV: 1, LI: 1, TR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    PRE: 1, BLOCKQUOTE: 1, TABLE: 1, TBODY: 1, THEAD: 1, UL: 1, OL: 1, BODY: 1, HTML: 1
  };

  function htmlToText(html) {
    if (!html) return '';
    var doc = new DOMParser().parseFromString(String(html), 'text/html');
    var out = '';
    (function walk(node) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType === 3) {
          var txt = n.nodeValue;
          // ⚠⚠ QTextEdit 的 toHtml() 是**带排版换行**的：
          //     `<body ...>\n<p>甲</p>\n<p>乙</p>\n`
          //   这些换行是纯文本节点，直接收进来会凭空多出一堆空行。
          //   HTML 的规矩本来就是「块级元素之间的空白不参与渲染」——
          //   所以只要这个空白节点挨着块级兄弟，就丢掉。
          if (/^\s*$/.test(txt)) {
            var p = n.parentNode;
            var sib = p ? p.childNodes : [];
            var idx = Array.prototype.indexOf.call(sib, n);
            var pv = sib[idx - 1], nx = sib[idx + 1];
            var nearBlock = (pv && pv.nodeType === 1 && BLOCKBOX[pv.tagName]) ||
                            (nx && nx.nodeType === 1 && BLOCKBOX[nx.tagName]);
            if (nearBlock) continue;
          }
          out += txt.replace(/\u00a0/g, ' ');
          continue;
        }
        if (n.nodeType !== 1) continue;
        var tag = n.tagName;
        if (tag === 'BR') { out += '\n'; continue; }
        if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'HEAD' || tag === 'TITLE') continue;
        var block = !!BLOCK[tag];
        if (block && out && !/\n$/.test(out)) out += '\n';
        walk(n);
        if (block && out && !/\n$/.test(out)) out += '\n';
      }
    })(doc.body);
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }

  /**
   * 纯文本 → HTML。
   *
   * ⚠⚠ 这里**刻意逐字照抄 QTextEdit 自己的 toHtml() 写法**（实测出来的）：
   *   · 普通段落：`<p style=" margin-top:0px; ...">文字</p>`
   *   · 空段落：`<p style="-qt-paragraph-type:empty; ..."><br /></p>`
   *   · 行首 / 连续空格：换成 `&nbsp;`
   *
   *   为什么非得照抄：
   *   1. 空行 —— 写 `<p></p>` 桌面端会把整个空段落**丢掉**（空行没了）；
   *      写 `<p><br/></p>` 又会变成**两行**。只有 `-qt-paragraph-type:empty`
   *      这一种写法正好给一行 —— 因为桌面端自己就是这么存的。
   *   2. 缩进 —— HTML 默认把连续空白压成一个，不换 `&nbsp;` 缩进全丢。
   *      只换行首和连续 2 个以上的，**不能全换**，否则整篇变不可断行，长句不折行。
   *
   *   照抄之后还有个额外好处：桌面端 setHtml 再存回来，形状一模一样，
   *   两端不会互相以为对方改过（否则每次同步都要打架）。
   */
  var P_STYLE = ' margin-top:0px; margin-bottom:0px; margin-left:0px;' +
                ' margin-right:0px; -qt-block-indent:0; text-indent:0px;';
  var P_EMPTY = ' -qt-paragraph-type:empty; margin-top:0px; margin-bottom:0px;' +
                ' margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;';

  function nbsp(n) { return new Array(n + 1).join('&nbsp;'); }

  function escLine(line) {
    var s = esc(line);
    s = s.replace(/^ +/g, function (m) { return nbsp(m.length); });
    s = s.replace(/(\S) {2,}/g, function (m, a) { return a + nbsp(m.length - 1); });
    return s;
  }

  function textToHtml(text) {
    if (!text) return '';
    return String(text).replace(/\r\n?/g, '\n').split('\n').map(function (line) {
      return line
        ? '<p style="' + P_STYLE + '">' + escLine(line) + '</p>'
        : '<p style="' + P_EMPTY + '"><br /></p>';
    }).join('');
  }

  /* ---------------------------------------------------------------- 计划 */

  /**
   * 把待办排成「分组 + 未分组」，和桌面端 `TodoList.plan()` 一个口径。
   * ⚠ 折叠 / 隐藏已完成**不影响计数** —— 计数一律从数据算（桌面端踩过这个坑）。
   */
  function plan() {
    var st = S.state;
    var gids = {};
    st.groups.forEach(function (g) { gids[g.id] = true; });
    var out = st.groups.map(function (g) {
      var items = st.todos.filter(function (t) { return t.group === g.id; });
      return { g: g, items: items, done: items.filter(function (t) { return t.done; }).length };
    });
    var loose = st.todos.filter(function (t) { return !t.group || !gids[t.group]; });
    return {
      groups: out, loose: loose, hasGroups: st.groups.length > 0,
      looseDone: loose.filter(function (t) { return t.done; }).length
    };
  }

  /** 可见条目（受「显示已完成」影响）。 */
  function visible(items) {
    return S.cfg.showDone ? items : items.filter(function (t) { return !t.done; });
  }

  /* ---------------------------------------------------------------- 渲染 */

  function render() {
    renderHeader();
    if (ui.tab === 'todo') renderTodo();
    else if (ui.tab === 'cal') renderCal();
    else if (ui.tab === 'memo') renderMemo();
    else renderSet();
  }

  function renderHeader() {
    var titles = { todo: '待办', cal: '日历', memo: '备忘', set: '设置' };
    $('#hdr-title').firstChild.nodeValue = titles[ui.tab];
    var sub = '';
    if (ui.tab === 'todo') {
      var n = S.state.todos.filter(function (t) { return !t.done; }).length;
      sub = n ? '剩 ' + n + ' 条' : '';
    }
    $('#hdr-sub').textContent = sub ? '　' + sub : '';

    var act = $('#hdr-act');
    if (ui.tab === 'todo') {
      act.hidden = false;
      act.textContent = ui.sortMode ? '完成' : '排序';
      act.className = 'hbtn' + (ui.sortMode ? '' : ' muted');
    } else if (ui.tab === 'memo') {
      act.hidden = false;
      act.textContent = '复制';
      act.className = 'hbtn muted';
    } else {
      act.hidden = true;
    }
    renderDot();
  }

  function renderDot() {
    var d = $('#dot');
    var st = S.status;
    d.className = '';
    if (!S.cfg.syncOn) { d.title = '同步未开启'; return; }
    if (S.busy) { d.className = 'busy'; d.title = '正在同步…'; return; }
    if (st.ok === true) { d.className = 'ok'; d.title = '已同步 · ' + st.at + (st.pulled ? ' · 拉回 ' + st.pulled + ' 条' : ''); return; }
    if (st.ok === false) { d.className = 'err'; d.title = '同步失败：' + (st.error || ''); return; }
    d.title = '还没同步过';
  }

  /* ------------------------------------------------------------ 待办页 */

  function todoRow(t) {
    var h = '<div class="row tap' + (t.done ? ' done' : '') + '" data-id="' + t.id + '">';
    h += '<button class="dot-check' + (t.done ? ' on' : '') + '" data-act="toggle">✓</button>';
    h += '<div class="grow"><div class="txt">' + esc(t.text) + '</div></div>';
    h += '<span class="star s' + (t.star || 0) + '">' + stars(t.star) + '</span>';
    if (ui.sortMode) {
      h += '<button class="mv" data-act="up">▲</button>';
      h += '<button class="mv" data-act="dn">▼</button>';
    }
    return h + '</div>';
  }

  function renderTodo() {
    var p = plan();
    var tools = '<div class="row" style="padding:6px 4px">' +
      '<button class="hbtn' + (S.cfg.showDone ? '' : ' muted') + '" data-act="showdone">' +
      (S.cfg.showDone ? '隐藏已完成' : '显示已完成') + '</button>' +
      '<div class="grow"></div>' +
      '<button class="hbtn muted" data-act="newgroup">＋ 新建分组</button>' +
      '</div>';
    $('#todo-tools').innerHTML = tools;

    // 新建时加到哪个分组 —— 记住上次选的，不用每次重挑
    var sel = $('#todo-group');
    var cur = ui.newTodoGroup || '';
    var opts = '<option value="">未分组</option>' + S.state.groups.map(function (g) {
      return '<option value="' + g.id + '">' + esc(g.name || '未命名') + '</option>';
    }).join('');
    if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
    if (S.state.groups.some(function (g) { return g.id === cur; }) || cur === '') {
      sel.value = cur;
    } else {
      sel.value = ''; ui.newTodoGroup = '';    // 选中的分组被删了 → 退回未分组
    }
    // 没有分组时这个下拉没意义，藏起来
    sel.style.display = S.state.groups.length ? '' : 'none';

    var h = '';
    if (!p.hasGroups) {
      // 没有分组就渲染成一列（和桌面端一样，不硬塞一个「未分组」头）
      var items = visible(p.loose);
      if (!items.length) h = '<div class="empty">' + (S.state.todos.length ? '都做完了 🎉' : '还没有待办，下面加一条') + '</div>';
      else h = '<div class="card">' + items.map(todoRow).join('') + '</div>';
    } else {
      // ⚠ 每组**单独一张卡**：组头是卡片顶上一条实心色块，子项在下面。
      //   这样「母文件夹 / 子项」的差别一眼就能看出来，组与组之间也自然分开了。
      p.groups.forEach(function (grp) {
        h += '<div class="card gcard">' +
          '<div class="ghead" data-gid="' + grp.g.id + '" data-act="fold">' +
          '<span class="tri">' + (grp.g.collapsed ? '▶' : '▼') + '</span>' +
          '<span class="gname">' + esc(grp.g.name || '未命名分组') + '</span>' +
          '<span class="gcount">' + grp.done + '/' + grp.items.length + '</span>' +
          '<button class="mv" data-act="gedit" style="width:26px;height:26px">⋯</button>' +
          '</div>';
        if (!grp.g.collapsed) {
          var its = visible(grp.items);
          h += '<div class="gwrap">';
          if (!its.length) h += '<div class="hint">（空' + (grp.items.length ? '，已完成都藏起来了' : '') + '）</div>';
          else its.forEach(function (t) { h += todoRow(t); });
          h += '</div>';
        }
        h += '</div>';
      });
      h += '<div class="card gcard">' +
        '<div class="ghead" data-act="fold-loose">' +
        '<span class="tri">' + (S.state.loose_collapsed ? '▶' : '▼') + '</span>' +
        '<span class="gname">未分组</span>' +
        '<span class="gcount">' + p.looseDone + '/' + p.loose.length + '</span></div>';
      if (!S.state.loose_collapsed) {
        var ls = visible(p.loose);
        h += '<div class="gwrap">';
        if (!ls.length) h += '<div class="hint">（空）</div>';
        else ls.forEach(function (t) { h += todoRow(t); });
        h += '</div>';
      }
      h += '</div>';
    }
    $('#todo-list').innerHTML = h;
  }

  /** 在同组内上下移动一条待办。⚠ 组内相对顺序才是有效信息。 */
  function moveTodo(id, dir) {
    S.mutate(function (st) {
      var gids = {};
      st.groups.forEach(function (g) { gids[g.id] = true; });
      var key = function (t) { return gids[t.group] ? t.group : ''; };
      var i = st.todos.findIndex(function (t) { return t.id === id; });
      if (i < 0) return;
      var k = key(st.todos[i]);
      var j = i + dir;
      while (j >= 0 && j < st.todos.length) {
        if (key(st.todos[j]) === k) {
          var tmp = st.todos[i];
          st.todos[i] = st.todos[j];
          st.todos[j] = tmp;
          return;
        }
        j += dir;
      }
    });
  }

  function addTodo(text) {
    text = (text || '').trim();
    if (!text) return;
    S.mutate(function (st) {
      st.todos.push({
        id: R.newId(), text: text, done: false, star: 0,
        group: ui.newTodoGroup || '', done_at: ''
      });
    });
  }

  /* ------------------------------------------------------------ 日历页 */

  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dayKey(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }

  function renderCal() {
    if (!ui.calY) { var t = new Date(); ui.calY = t.getFullYear(); ui.calM = t.getMonth(); }
    $('#cal-title').textContent = ui.calY + '年' + (ui.calM + 1) + '月';

    var first = new Date(ui.calY, ui.calM, 1);
    var start = new Date(ui.calY, ui.calM, 1 - first.getDay());
    var today = new Date();
    var tkey = dayKey(today.getFullYear(), today.getMonth(), today.getDate());

    var h = '';
    WEEK.forEach(function (w) { h += '<div class="wk">' + w + '</div>'; });

    // {日期: 这天划掉了几项} —— 只在循环外扫一遍 todos，别在 42 个格子里各扫一次
    var finMap = {};
    S.state.todos.forEach(function (t) {
      if (t.done && t.done_at) finMap[t.done_at] = (finMap[t.done_at] || 0) + 1;
    });

    for (var i = 0; i < 42; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var k = dayKey(d.getFullYear(), d.getMonth(), d.getDate());
      var out = d.getMonth() !== ui.calM;
      var n = (S.state.cal[k] || []).length;
      var cls = 'd' + (out ? ' out' : '') + (k === tkey ? ' today' : '') + (k === ui.selDay ? ' sel' : '');
      h += '<div class="' + cls + '" data-day="' + k + '">' + d.getDate() +
        (n ? '<span class="pd"></span>' : '') +
        (finMap[k] ? '<span class="fd"></span>' : '') + '</div>';
    }
    $('#calgrid').innerHTML = h;

    var total = Object.keys(S.state.cal).filter(function (x) { return (S.state.cal[x] || []).length; }).length;
    $('#cal-hint').textContent = total
      ? '本月及附近共 ' + total + ' 天有记录，点日期看当天内容。'
      : '还没有任何日期备注，点日期就能加。';
  }

  function openDay(key) {
    ui.selDay = key;
    renderCal();
    var d = new Date(key + 'T00:00:00');
    var title = d.getMonth() + 1 + '月' + d.getDate() + '日 · 周' + WEEK[d.getDay()];
    openSheet(
      '<h3>' + title + '</h3><div id="daylist"></div>' +
      '<div class="lbl">加一条</div>' +
      '<div style="display:flex;gap:8px"><input type="text" id="day-inp" placeholder="当天要做什么…" ' +
      'autocomplete="off" enterkeyhint="done"><button class="addbtn" id="day-add">＋</button></div>',
      function (root) {
        drawDay(root, key);
        var inp = $('#day-inp', root);
        $('#day-add', root).addEventListener('click', function () { addDay(root, key, inp); });
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); addDay(root, key, inp); }
        });
      });
  }

  function drawDay(root, key) {
    var items = S.state.cal[key] || [];
    // 这天在待办清单里划掉的项目（和桌面 DayDialog 里那块对应）
    var fin = S.state.todos.filter(function (t) { return t.done && t.done_at === key; });
    var h = '';
    if (!items.length && !fin.length) h = '<div class="hint">这天还没有记录。</div>';
    items.forEach(function (x) {
      var gname = '';
      S.state.groups.forEach(function (g) { if (g.id === x.group) gname = g.name; });
      h += '<div class="row' + (x.done ? ' done' : '') + '" data-cid="' + x.id + '">' +
        '<button class="dot-check' + (x.done ? ' on' : '') + '" data-act="ctoggle">✓</button>' +
        '<div class="grow"><div class="txt">' + esc(x.text) + '</div>' +
        (gname ? '<div class="sub">' + esc(gname) + '</div>' : '') + '</div>' +
        '<button class="mv del" data-act="cdel" style="width:30px;height:30px">✕</button></div>';
    });
    if (fin.length) {
      h += '<div class="lbl">这天划掉的 · ' + fin.length + '</div>';
      fin.forEach(function (t) {
        var gname = '';
        S.state.groups.forEach(function (g) { if (g.id === t.group) gname = g.name; });
        h += '<div class="row done">' +
          '<button class="dot-check on" disabled>✓</button>' +
          '<div class="grow"><div class="txt">' + esc(t.text) + '</div>' +
          (gname ? '<div class="sub">' + esc(gname) + '</div>' : '') + '</div></div>';
      });
    }
    // 已完成、但没记完成日期的（10-17 之前划掉的，或同步时丢了 done_at 的）。
    // ⚠ 不单独列出来的话，这些条目在**任何一天**的日历上都看不到 —— 等于凭空消失。
    var und = S.state.todos.filter(function (t) { return t.done && !t.done_at; });
    if (und.length) {
      h += '<div class="lbl">已完成 · 未记日期 · ' + und.length + '</div>';
      und.forEach(function (t) {
        h += '<div class="row done" data-tid="' + t.id + '">' +
          '<button class="dot-check on" disabled>✓</button>' +
          '<div class="grow"><div class="txt">' + esc(t.text) + '</div></div>' +
          '<button class="mv attach" data-act="attach">挂到这天</button></div>';
      });
    }
    $('#daylist', root).innerHTML = h;
  }

  function addDay(root, key, inp) {
    var v = (inp.value || '').trim();
    if (!v) return;
    S.mutate(function (st) {
      if (!st.cal[key]) st.cal[key] = [];
      st.cal[key].push({ id: R.newId(), text: v, group: ui.newTodoGroup || '', done: false });
    });
    inp.value = '';
    drawDay(root, key);
    renderCal();
  }

  /* ------------------------------------------------------------ 备忘页 */

  function renderMemo() {
    var el = $('#memo');
    // ⚠ 用户正在打字时绝不回写 —— 会把光标顶走
    if (!ui.memoFocus && !ui.memoDirty) {
      var txt = htmlToText(S.state.memo_html);
      el.value = txt;
      ui.memoSaved = txt;
    }
    var n = (el.value || '').length;
    var up = S.state.memo_updated || '';
    $('#memo-info').innerHTML = n + ' 字' + (up ? ' · 已存 ' + esc(up) : '') +
      '<br>⚠ 在手机上编辑会丢掉电脑端的粗体、颜色等格式（内容不会丢）。';
  }

  var memoTimer = null;
  function onMemoInput() {
    ui.memoDirty = true;
    clearTimeout(memoTimer);
    memoTimer = setTimeout(saveMemo, 800);
  }

  function saveMemo() {
    var el = $('#memo');
    var txt = el.value;
    if (txt === ui.memoSaved) { ui.memoDirty = false; return; }
    var html = textToHtml(txt);
    S.mutate(function (st) {
      st.memo_html = html;
      st.memo_updated = R.stamp();
    });
    ui.memoSaved = txt;
    ui.memoDirty = false;
    renderMemo();
  }

  /* ------------------------------------------------------------ 设置页 */

  function renderSet() {
    var cfg = S.cfg, gh = GH.getCfg();
    var h = '';

    // ---- 同步
    h += '<div class="sec-t">双端同步</div><div class="card">';
    h += '<div class="row"><div class="grow"><div class="txt">开启同步</div>' +
      '<div class="sub">待办 / 日历 / 备忘 与电脑端双向同步</div></div>' +
      '<button class="btn' + (cfg.syncOn ? '' : ' ghost') + '" data-act="toggle-sync" ' +
      'style="width:auto;padding:7px 14px">' + (cfg.syncOn ? '已开启' : '已关闭') + '</button></div>';

    h += '<div class="row"><div class="grow"><div class="txt">GitHub</div>' +
      '<div class="sub">' + (GH.isSignedIn() ? esc(GH.account()) : '还没填 Token') + '</div></div>' +
      (GH.isSignedIn()
        ? '<button class="hbtn" data-act="signout">断开</button>'
        : '<button class="hbtn" data-act="checktoken">连接</button>') + '</div>';

    h += '<div class="row"><div class="grow"><div class="txt">立即同步</div>' +
      '<div class="sub" id="syncmsg">' + syncMsg() + '</div></div>' +
      '<button class="hbtn" data-act="syncnow">同步</button></div>';
    h += '</div>';

    // ---- 同步设置
    h += '<div class="sec-t">同步设置</div><div class="card">';
    h += '<div class="row"><div class="grow"><div class="txt">GitHub Token</div>' +
      '<div class="sub">在 GitHub 生成一个 Fine-grained Token，权限只勾 ' +
      '<b>Account permissions → Gists: Read and write</b> 就够</div>' +
      '<input type="password" id="set-token" placeholder="github_pat_… 或 ghp_…" ' +
      'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
      'style="margin-top:8px" value="' + esc(gh.token || '') + '"></div></div>';
    h += '<div class="row"><div class="grow"><div class="txt">Gist 地址</div>' +
      '<div class="sub">只填那一串 id（Gist 网址最后那段）。' +
      '<b>留空也行</b> —— 第一次同步会自动建一个私密 Gist，地址会填回来</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">' +
      '<input type="text" id="set-gist" placeholder="留空 = 自动新建" ' +
      'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
      'value="' + esc(gh.gist || '') + '">' +
      '<button class="hbtn" data-act="newgist" style="flex:0 0 auto">新建</button></div></div></div>';
    h += '<div class="row"><div class="grow"><div class="txt">同步文件</div>' +
      '<div class="sub">Gist 里那个文件的名字，两端约定好的，不用改</div>' +
      '<div class="mono" style="margin-top:6px">' + esc(GH.FILE) + '</div></div></div>';
    h += '<div class="row tap" data-act="opengist"><div class="grow"><div class="txt">打开 Gist 页面</div>' +
      '<div class="sub">' + (gh.gist ? 'gist.github.com/' + esc(gh.gist) : '还没有 Gist') +
      '</div></div><span class="chev">›</span></div>';
    h += '</div>';

    // ---- 外观
    h += '<div class="sec-t">外观</div><div class="card">';
    h += '<div class="row"><div class="grow"><div class="txt">主题</div></div>' +
      '<select id="set-theme" style="width:auto;flex:0 0 auto">' +
      ['auto:跟随系统', 'light:浅色', 'dark:深色'].map(function (o) {
        var kv = o.split(':');
        return '<option value="' + kv[0] + '"' + (cfg.theme === kv[0] ? ' selected' : '') + '>' + kv[1] + '</option>';
      }).join('') + '</select></div>';
    h += '</div>';

    // ---- 数据
    h += '<div class="sec-t">数据</div><div class="card">';
    h += '<div class="row tap" data-act="export"><div class="grow"><div class="txt">导出备份</div>' +
      '<div class="sub">存成一个 JSON 文件，可随时导入回来</div></div><span class="chev">›</span></div>';
    h += '<div class="row tap" data-act="import"><div class="grow"><div class="txt">从文件导入</div>' +
      '<div class="sub warn">会覆盖当前全部内容</div></div><span class="chev">›</span></div>';
    h += '<div class="row tap" data-act="wipe"><div class="grow"><div class="txt err">清空本机数据</div>' +
      '<div class="sub">只清这台手机上的，Gist 和电脑端不动</div></div><span class="chev">›</span></div>';
    h += '</div>';

    // ---- 关于
    h += '<div class="sec-t">关于</div><div class="card">';
    h += '<div class="row"><div class="grow"><div class="txt">小浮窗 · 手机版</div>' +
      '<div class="sub">和电脑端共用一份同步文档，改动按「最后写入的赢」合并，' +
      '而且只影响改到的那一条。同一时刻的冲突以删除为准，所以删掉的东西不会自己回来。</div></div></div>';
    // ★ 版本 / 自检（2026-10-16 加，2026-10-17 扩成三项）
    //   改完界面如果手机上看不到变化，翻到这一页看这行。
    //   ⚠ 只显示 SW 缓存名是**不够的**（上一版就栽在这）：缓存名对得上、CSS 却还是旧的。
    //   现在三样一起给，一眼定案：
    //     b8        → app.js 是新的（常量写死在代码里）
    //     fixed     → app.css 是新的（旧版底栏是 static，v8 起是 fixed）
    //     852/852   → 底栏底边 / 视口高。两个数相等 = 真的贴底；差几十 = 没贴住
    h += '<div class="row"><div class="grow"><div class="txt">界面版本</div>' +
      '<div class="sub">看不到最新改动时，翻到这一页核对这行</div></div>' +
      '<span class="mono" id="ver-slot">…</span></div>';
    h += '</div>';

    h += '<div class="hint" style="padding-bottom:20px">' +
      'Token 只保存在这台手机上，<b>不会</b>写进同步文档 —— 电脑端和手机端各填各的。' +
      'Gist 是私密的，别人搜不到。' +
      '</div>';

    $('#set-body').innerHTML = h;

    // ⚠ 这行以前是「读 Cache Storage 的缓存名」，看起来更权威，其实**会骗人**：
    //   缓存名只能证明 SW 换了版本，页面完全可能是「新 SW + 旧文件快照」。
    //   现在改成直接量：代码构建号 + 底栏的 computed position + 底栏底边/视口高。
    var el = $('#ver-slot');
    if (el) el.textContent = verText();
  }

  /* 一行自检：`b8 · fixed · 852/852 ✓`
       · b8     = app.js 构建号（写死在上面的常量）
       · fixed  = #tabs 的 position。旧版 app.css 是 static → 说明 CSS 还是旧的
       · 852/852 = 底栏底边 / 视口高。相等就是真贴底，差多少直接写出来
     这三样合起来，**不用截图、不用猜**，用户念一下就知道问题在哪一层。 */
  function verText() {
    var out = [APP_BUILD];
    var t = $('#tabs');
    if (!t) return out.join(' · ');
    var cs = getComputedStyle(t);
    out.push(cs.position || '?');
    var b = Math.round(t.getBoundingClientRect().bottom);
    var vh = Math.round(window.innerHeight);
    var d = vh - b;
    out.push(b + '/' + vh + (Math.abs(d) <= 1 ? ' ✓' : ' ✗' + d));
    return out.join(' · ');
  }

  function syncMsg() {
    if (!S.cfg.syncOn) return '同步没开';
    if (!GH.isSignedIn()) return '还没填 GitHub Token';
    var st = S.status;
    if (S.busy) return '正在同步…';
    if (st.ok === true) return '✓ 已同步 · ' + st.at + (st.pulled ? ' · 拉回 ' + st.pulled + ' 条' : '');
    if (st.ok === false) return '✗ ' + (st.error || '失败');
    return '还没同步过，点右边跑一次';
  }

  /* ---------------------------------------------------------------- 事件 */

  // 底部标签
  function switchTab(name) {
    if (!/^(todo|cal|memo|set)$/.test(name)) return;
    ui.tab = name;
    $$('#tabs button').forEach(function (x) { x.classList.toggle('on', x.dataset.tab === name); });
    $$('.page').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + name); });
    if (name === 'memo') ui.memoFocus = false;
    render();
  }

  $('#tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  // 顶栏动作
  $('#hdr-act').addEventListener('click', function () {
    if (ui.tab === 'todo') { ui.sortMode = !ui.sortMode; render(); }
    else if (ui.tab === 'memo') {
      var t = $('#memo').value;
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { toast('已复制'); },
        function () { toast('复制失败'); });
      else toast('这个浏览器不支持复制');
    }
  });

  // 待办页
  $('#todo-tools').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'showdone') { S.saveCfg({ showDone: !S.cfg.showDone }); render(); }
    if (b.dataset.act === 'newgroup') askNewGroup();
  });

  $('#todo-list').addEventListener('click', function (e) {
    var ghead = e.target.closest('.ghead');
    if (ghead) {
      var act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'gedit') { openGroupSheet(ghead.dataset.gid); return; }
      var gid = ghead.dataset.gid;
      S.mutate(function (st) {
        if (gid) {
          st.groups.forEach(function (g) { if (g.id === gid) g.collapsed = !g.collapsed; });
        } else {
          st.loose_collapsed = !st.loose_collapsed;
        }
      });
      render();
      return;
    }
    var row = e.target.closest('.row[data-id]');
    if (!row) return;
    var id = row.dataset.id;
    var act2 = e.target.closest('[data-act]');
    var a = act2 ? act2.dataset.act : '';
    if (a === 'toggle') {
      // ⚠ 别用 toISOString().slice(0,10)：那是 UTC —— 东八区晚上 8 点后
      //   算出来的是「昨天」，灰圈会标错格子。
      var _t = new Date();
      var today = dayKey(_t.getFullYear(), _t.getMonth(), _t.getDate());
      S.mutate(function (st) {
        st.todos.forEach(function (t) {
          if (t.id !== id) return;
          t.done = !t.done;
          // 完成日期（桌面日历上那个灰圈）—— 取消勾选要一起清掉
          t.done_at = t.done ? today : '';
        });
      });
      render();
    } else if (a === 'up' || a === 'dn') {
      moveTodo(id, a === 'up' ? -1 : 1);
      render();
    } else if (!ui.sortMode) {
      openTodoSheet(id);
    }
  });

  $('#todo-add').addEventListener('click', function () {
    var inp = $('#todo-inp');
    addTodo(inp.value);
    inp.value = '';
    inp.focus();
    render();
  });
  $('#todo-inp').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTodo(this.value);
      this.value = '';
      render();
    }
  });
  $('#todo-group').addEventListener('change', function () {
    ui.newTodoGroup = this.value;
  });

  // 日历页
  $('#cal-prev').addEventListener('click', function () {
    ui.calM--; if (ui.calM < 0) { ui.calM = 11; ui.calY--; } renderCal();
  });
  $('#cal-next').addEventListener('click', function () {
    ui.calM++; if (ui.calM > 11) { ui.calM = 0; ui.calY++; } renderCal();
  });
  $('#calgrid').addEventListener('click', function (e) {
    var c = e.target.closest('.d[data-day]');
    if (c) openDay(c.dataset.day);
  });

  // 当天备注弹层里的勾选 / 删除
  $('#sheet-body').addEventListener('click', function (e) {
    if (!ui.selDay) return;

    // 「已完成 · 未记日期」里的一键挂到当前这天
    var urow = e.target.closest('.row[data-tid]');
    if (urow) {
      var uact = e.target.closest('[data-act]');
      if (uact && uact.dataset.act === 'attach') {
        var tid = urow.dataset.tid, dkey = ui.selDay;
        S.mutate(function (st) {
          st.todos.forEach(function (t) { if (t.id === tid && t.done) t.done_at = dkey; });
        });
        drawDay($('#sheet-body'), dkey);
        renderCal();
      }
      return;
    }

    var row = e.target.closest('.row[data-cid]');
    if (!row) return;
    var id = row.dataset.cid, key = ui.selDay;
    var act = e.target.closest('[data-act]');
    var a = act ? act.dataset.act : '';
    if (a === 'ctoggle') {
      S.mutate(function (st) {
        (st.cal[key] || []).forEach(function (x) { if (x.id === id) x.done = !x.done; });
      });
      drawDay($('#sheet-body'), key);
      renderCal();
    } else if (a === 'cdel') {
      S.mutate(function (st) {
        st.cal[key] = (st.cal[key] || []).filter(function (x) { return x.id !== id; });
        if (!st.cal[key].length) delete st.cal[key];
      });
      drawDay($('#sheet-body'), key);
      renderCal();
    }
  });

  // 备忘
  $('#memo').addEventListener('input', onMemoInput);
  $('#memo').addEventListener('focus', function () { ui.memoFocus = true; });
  $('#memo').addEventListener('blur', function () {
    ui.memoFocus = false;
    clearTimeout(memoTimer);
    saveMemo();
  });

  // 设置页
  $('#set-body').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var a = b.dataset.act;
    if (a === 'toggle-sync') {
      S.saveCfg({ syncOn: !S.cfg.syncOn });
      renderSet();
      if (S.cfg.syncOn && GH.isSignedIn()) doSync();
    } else if (a === 'checktoken') {
      doCheckToken();
    } else if (a === 'signout') {
      GH.signOut();
      toast('已断开（GitHub 上的 Gist 没动）');
      renderSet();
    } else if (a === 'newgist') {
      doNewGist();
    } else if (a === 'opengist') {
      var u = GH.gistUrl();
      if (!u) { toast('还没有 Gist —— 先同步一次，会自动建一个'); return; }
      window.open(u, '_blank');
    } else if (a === 'syncnow') {
      doSync();
    } else if (a === 'export') {
      doExport();
    } else if (a === 'import') {
      doImport();
    } else if (a === 'wipe') {
      confirmSheet('清空本机数据', '只清这台手机上的待办 / 日历 / 备忘。Gist 里的和电脑端不受影响，下次同步还会拉回来。',
        '清空', function () { S.wipe(); closeSheet(); render(); toast('已清空'); });
    }
  });

  $('#set-body').addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'set-token') {
      GH.setCfg({ token: t.value.trim() });
      toast('已保存，现在可以点「连接」验证一下');
      renderSet();
    } else if (t.id === 'set-gist') {
      GH.setCfg({ gist: t.value.trim() });
      // ⚠ 换了 Gist 要重载一次 —— Store.load() 会据此把同步状态清掉（重新配对）
      S.load();
      toast('已保存');
      renderSet();
    } else if (t.id === 'set-theme') { applyTheme(t.value); S.saveCfg({ theme: t.value }); }
  });

  /* ------------------------------------------------------------ 弹层：待办 */

  function openTodoSheet(id) {
    var t = S.state.todos.find(function (x) { return x.id === id; });
    if (!t) return;
    var opts = '<option value="">未分组</option>' + S.state.groups.map(function (g) {
      return '<option value="' + g.id + '"' + (g.id === t.group ? ' selected' : '') + '>' +
        esc(g.name || '未命名') + '</option>';
    }).join('');
    openSheet(
      '<h3>编辑待办</h3>' +
      '<input type="text" id="e-text" value="' + esc(t.text) + '">' +
      '<div class="lbl">分组</div><select id="e-group">' + opts + '</select>' +
      '<div class="lbl">重要程度</div>' +
      '<div style="display:flex;gap:8px">' +
      [0, 1, 2, 3].map(function (n) {
        return '<button class="btn' + (n === (t.star || 0) ? '' : ' ghost') + '" data-star="' + n + '">' +
          stars(n) + '</button>';
      }).join('') + '</div>' +
      '<div style="height:16px"></div>' +
      '<button class="btn" id="e-save">保存</button>' +
      '<div style="height:8px"></div>' +
      '<button class="btn danger" id="e-del">删除</button>',
      function (root) {
        var star = t.star || 0;
        $$('[data-star]', root).forEach(function (b) {
          b.addEventListener('click', function () {
            star = parseInt(b.dataset.star, 10);
            $$('[data-star]', root).forEach(function (x) {
              x.className = 'btn' + (parseInt(x.dataset.star, 10) === star ? '' : ' ghost');
            });
          });
        });
        $('#e-save', root).addEventListener('click', function () {
          var txt = $('#e-text', root).value.trim();
          var grp = $('#e-group', root).value;
          if (!txt) { toast('内容不能为空'); return; }
          S.mutate(function (st) {
            st.todos.forEach(function (x) {
              if (x.id === id) { x.text = txt; x.group = grp; x.star = star; }
            });
          });
          closeSheet(); render(); toast('已保存');
        });
        $('#e-del', root).addEventListener('click', function () {
          confirmSheet('删除这条待办', '「' + txt0(t.text) + '」', '删除', function () {
            S.mutate(function (st) { st.todos = st.todos.filter(function (x) { return x.id !== id; }); });
            closeSheet(); render(); toast('已删除');
          });
        });
      });
  }
  function txt0(s) { s = String(s || ''); return s.length > 18 ? s.slice(0, 18) + '…' : s; }

  function openGroupSheet(gid) {
    var g = S.state.groups.find(function (x) { return x.id === gid; });
    if (!g) return;
    var n = S.state.todos.filter(function (t) { return t.group === gid; }).length;
    openSheet(
      '<h3>分组</h3>' +
      '<input type="text" id="g-name" value="' + esc(g.name) + '">' +
      '<div style="height:16px"></div>' +
      '<button class="btn" id="g-save">保存名称</button>' +
      '<div style="height:8px"></div>' +
      '<button class="btn danger" id="g-del">删除分组（' + n + ' 条会变成未分组）</button>',
      function (root) {
        $('#g-save', root).addEventListener('click', function () {
          var v = $('#g-name', root).value.trim() || '未命名';
          S.mutate(function (st) {
            st.groups.forEach(function (x) { if (x.id === gid) x.name = v; });
          });
          closeSheet(); render(); toast('已改名');
        });
        $('#g-del', root).addEventListener('click', function () {
          confirmSheet('删除分组', '「' + esc(g.name) + '」里的 ' + n + ' 条待办会变成未分组，不会被删掉。',
            '删除分组', function () {
              S.mutate(function (st) {
                st.groups = st.groups.filter(function (x) { return x.id !== gid; });
                st.todos.forEach(function (t) { if (t.group === gid) t.group = ''; });
              });
              closeSheet(); render(); toast('已删除分组');
            });
        });
      });
  }

  function askNewGroup() {
    openSheet('<h3>新建分组</h3><input type="text" id="ng-name" placeholder="分组名">' +
      '<div style="height:16px"></div><button class="btn" id="ng-ok">创建</button>',
      function (root) {
        var inp = $('#ng-name', root);
        setTimeout(function () { inp.focus(); }, 120);
        $('#ng-ok', root).addEventListener('click', function () {
          var v = inp.value.trim();
          if (!v) { toast('名字不能为空'); return; }
          S.mutate(function (st) { st.groups.push({ id: R.newId(), name: v, collapsed: false }); });
          closeSheet(); render(); toast('已创建');
        });
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); $('#ng-ok', root).click(); }
        });
      });
  }

  function confirmSheet(title, body, okText, onOk) {
    openSheet('<h3>' + esc(title) + '</h3><div class="hint">' + body + '</div>' +
      '<div style="height:16px"></div><button class="btn danger" id="cf-ok">' + esc(okText) + '</button>' +
      '<div style="height:8px"></div><button class="btn ghost" id="cf-no">取消</button>',
      function (root) {
        $('#cf-ok', root).addEventListener('click', onOk);
        $('#cf-no', root).addEventListener('click', closeSheet);
      });
  }

  /* ------------------------------------------------------------ 同步动作 */

  /** 「连接」：验一下 Token 能不能用（顺便把登录名取回来显示）。 */
  function doCheckToken() {
    var inp = $('#set-token');
    if (inp && inp.value.trim()) GH.setCfg({ token: inp.value.trim() });
    if (!GH.getCfg().token) { toast('先填 GitHub Token'); return; }
    toast('正在验证 Token…');
    GH.verify().then(function (who) {
      toast('已连接：' + who);
      renderSet();
    }).catch(function (e) {
      toast('连接失败：' + e.message, 6000);
    });
  }

  /** 「新建」：建一个私密 Gist（不覆盖已有数据，只是换个地方存）。 */
  function doNewGist() {
    var inp = $('#set-token');
    if (inp && inp.value.trim()) GH.setCfg({ token: inp.value.trim() });
    if (!GH.getCfg().token) { toast('先填 GitHub Token'); return; }
    toast('正在新建私密 Gist…');
    GH.createGist().then(function (id) {
      S.load();                       // 换 Gist = 重新配对，同步状态要一起清
      renderSet();
      toast('已新建：' + id);
    }).catch(function (e) {
      toast('新建失败：' + e.message, 6000);
    });
  }

  function doSync() {
    // ⚠ 守卫**只写在 `Store.sync()` 里这一处**，这里不再重复判。
    //   两处都判的话，失败原因就只进了 toast、进不了 `Store.status`，
    //   于是设置页那行状态还停在「还没同步过」——界面和状态对不上。
    S.sync().then(function (r) {
      render();
      toast(r.pulled ? ('同步完成 · 拉回 ' + r.pulled + ' 条') : '同步完成 · 没有新东西');
    }).catch(function (e) {
      render();
      toast('同步失败：' + e.message, 5000);
    });
  }

  function doExport() {
    var blob = new Blob([S.exportJson()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '小浮窗备份 ' + R.stamp().replace(/[: ]/g, '-') + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast('已导出');
  }

  function doImport() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          S.importJson(String(rd.result));
          render(); toast('已导入');
        } catch (e) { toast('导入失败：' + e.message, 4000); }
      };
      rd.readAsText(f);
    });
    inp.click();
  }

  /* ---------------------------------------------------------------- 主题 */

  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    var dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', dark ? '#000000' : '#F2F2F7');
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    S.load();

    // ⚠⚠ 一次性数据修补（2026-10-19）：`done_at` 是 2026-10-17 才加上的字段，
    //   在那之前划掉的条目只有 done:true、没有完成日期 → 日历上**永远不显示**。
    //   toto 确认「合同拆分」「收据」两项是 10-16 划掉的，按他给的日子补上。
    //   ⚠ 必须打标记：否则他以后取消勾选（done_at 被清空）会被强行改回 10-16。
    //   ⚠ 只有真补上了才打标记 —— 首次装 App 时状态还是空的，别把机会用掉。
    try {
      if (!localStorage.getItem('fw_fix_done_at_v1')) {
        var FIX_DONE_AT = { '659fe6b0a4a8': '2026-10-16', '30029138f61f': '2026-10-16' };
        var nFix = 0;
        S.mutate(function (st) {
          st.todos.forEach(function (t) {
            if (t.done && !t.done_at && FIX_DONE_AT[t.id]) {
              t.done_at = FIX_DONE_AT[t.id];
              nFix++;
            }
          });
        });
        if (nFix) localStorage.setItem('fw_fix_done_at_v1', '1');
      }
    } catch (e) { console.warn('[fix] done_at 修补跳过', e); }

    applyTheme(S.cfg.theme);

    // 从主屏图标的长按菜单进来时可能带着 ?t=cal 这种，先认一下
    var q0;
    try { q0 = new URLSearchParams(location.search); } catch (e) { q0 = null; }
    var wantTab = q0 && q0.get('t');
    if (wantTab) switchTab(wantTab);

    S.subscribe(function () { /* 状态变化时只重画当前页，避免输入框失焦 */ if (!ui.memoFocus) render(); });

    // ⚠ 启动时顺手验一次 Token（把登录名取回来显示）。失败不弹错 ——
    //   手机可能只是暂时没网，等真去同步时再报。
    if (GH.isSignedIn() && !GH.getCfg().user) {
      GH.verify().then(function () { if (ui.tab === 'set') renderSet(); })
        .catch(function () {});
    }

    render();
    if (S.cfg.syncOn && GH.isSignedIn()) {
      S.sync().then(function (r) {
        ui.lastSync = Date.now();
        render();
        if (r.pulled) toast('已从电脑端拉回 ' + r.pulled + ' 条');
      }).catch(function (e) { render(); toast('同步失败：' + e.message, 4000); });
    }

    // 回到前台时顺手同步一次。
    // ⚠ 不做后台轮询（手机上没有可靠的定时器，还费电），只在「切回前台」这个
    //   明确时机跑；并且 60 秒内不重复跑，免得来回切 App 时反复打网络。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!S.cfg.syncOn || !GH.isSignedIn() || S.busy) return;
      if (Date.now() - ui.lastSync < 60000) return;
      S.sync().then(function (r) {
        ui.lastSync = Date.now(); render();
        if (r.pulled) toast('已拉回 ' + r.pulled + ' 条');
      }).catch(function () { render(); });
    });

    // ★★ 可视区校正（2026-10-17，iPhone 14 Pro 实测后加）
    //   `position: fixed; bottom: 0` 锚的是**布局视口**。但 iPhone 上 Safari 的
    //   底部地址栏是**浮在页面之上**的：地址栏露出来时，布局视口底部那 ~50px
    //   其实被它盖住了 —— 标签栏老老实实贴到了「布局视口」底，看起来却像
    //   「下方空了一截」（露出来的是画布底色）。
    //   visualViewport 给的才是**真正看得见**的那块：算出它离布局视口底差多少，
    //   塞进 --vv-gap，CSS 里 `#tabs { bottom: var(--vv-gap) }` 跟着抬。
    //   ⚠ 超过 140px 不抬 —— 那是**键盘弹起**（不是地址栏），抬了标签栏会飞到半空。
    //   ★ 2026-10-20：`--vv-gap` 现在只顶**内容**（`#tabs` 的 padding-bottom），
    //     标签栏白底始终铺到视口底 —— 所以这里算错了也不会再露白框，
    //     最多是图标文字上下挪一点。顺手加了三条降噪：
    //     ① < 12px 当噪声归零（地址栏最小也有 44px，十几像素的都是滚动抖动）
    //     ② 地址栏动画结束后用 rAF 再采一次，取稳定值
    //     ③ 页面重新可见 / 从缓存恢复时重算（iOS 切后台回来 visualViewport 常是旧值）
    //   ⚠⚠ 2026-10-20 补：**必须减掉底部安全区**。
    //     实测 toto 截图里露出的灰带 ≈ 86px，而 iPhone 14 Pro 的地址栏 ≈ 50、
    //     安全区 = 34 —— 86 = 50 + 34。也就是说 `innerHeight - (offsetTop + height)`
    //     量到的是「地址栏 + 安全区」，但 `#tabs button` 的
    //     `height: calc(46px + var(--safe-b))` **已经把安全区算进去了**，
    //     再抬一遍就是重复 → 标签栏凭空高出一截。减掉才是地址栏的真实高度。
    var vvTimer = 0;
    var _safeB = -1;
    function measureSafeB() {
      if (_safeB >= 0) return _safeB;
      try {
        var d = document.createElement('div');
        d.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;' +
          'padding-bottom:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none;';
        document.body.appendChild(d);
        _safeB = Math.round(d.getBoundingClientRect().height) || 0;
        document.body.removeChild(d);
      } catch (e) { _safeB = 0; }
      return _safeB;
    }
    function syncVvGap() {
      var vv = window.visualViewport;
      var gap = 0;
      if (vv) {
        gap = Math.round(window.innerHeight - (vv.offsetTop + vv.height)) - measureSafeB();
      }
      if (!(gap >= 12) || gap > 140) gap = 0;
      document.documentElement.style.setProperty('--vv-gap', gap + 'px');
    }
    function syncVvGapSoon() {
      syncVvGap();
      if (vvTimer) cancelAnimationFrame(vvTimer);
      // 地址栏收起/展开有 ~250ms 动画，动画中途量到的是中间值 → 结束后再量一次
      vvTimer = requestAnimationFrame(function () { vvTimer = requestAnimationFrame(syncVvGap); });
    }
    syncVvGap();
    // ★★ 兜底：**就算手机上缓存着旧版 app.css，也把底栏钉到视口底**（2026-10-20）
    //   旧写法是 `#tabs { bottom: var(--vv-gap) }` —— 整条底栏被抬起来，
    //   下面空出一截露 body 背景（toto 截图里那条 86px 灰带就是这么来的）。
    //   内联样式优先级高于样式表里的普通声明，所以这两行能直接盖掉旧 CSS 的写法，
    //   不用等缓存过期 / 用户重装 App。
    try {
      var tabsEl = document.getElementById('tabs');
      if (tabsEl) {
        tabsEl.style.bottom = '0';
        tabsEl.style.paddingBottom = 'var(--vv-gap, 0px)';
      }
    } catch (e) { /* 老浏览器没有 style 就算了 */ }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncVvGapSoon);
      window.visualViewport.addEventListener('scroll', syncVvGapSoon);
    }
    window.addEventListener('orientationchange', syncVvGapSoon);
    window.addEventListener('resize', syncVvGapSoon);
    window.addEventListener('pageshow', syncVvGapSoon);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) syncVvGapSoon();
    });

    // 注册 Service Worker（离线可开）
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      // ★★ 新版本装好后**自动刷一次页面**（2026-10-16）。
      //   为什么需要：sw.js 走的是 stale-while-revalidate —— 打开的那一瞬间，
      //   页面**已经被旧缓存渲染完了**；新文件其实已经装好，但要等**下一次**打开才生效。
      //   结果就是每次改完都「看着没变」，以为没推上去（toto 已经踩过两次）。
      //   这里监听 controllerchange（新 SW 接管当前页）→ 自动 reload 一次
      //   → 用户打开一次就是新版，不用手动关掉重开。
      //   ⚠ 两个防死循环的保险：
      //     ① 首次注册时 `clients.claim()` 也会触发 controllerchange，那不算「更新」
      //        → 用「进来时本来就有没有 controller」判断，第一次不刷。
      //     ② 刷过一次就不再刷（reload 后 SW 已是最新，本来也不会再触发，再加一道）。
      var hadCtl = !!navigator.serviceWorker.controller;
      var swReloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadCtl || swReloaded) return;
        swReloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').catch(function () { /* 无所谓 */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // ⚠ 给探针用的后门：这两个转换函数是「两端数据不漂移」的关键，
  //   必须能被自动化测试单独调用（见 softwork/_probe/_memo_roundtrip.py）。
  window.__fw = { htmlToText: htmlToText, textToHtml: textToHtml };
})();
