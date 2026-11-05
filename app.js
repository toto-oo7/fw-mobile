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
  var A = window.Account;

  /* ★★ 界面代码的「构建号」—— **写死在这里**，每次改界面就改一下（2026-10-17 加）。
     为什么不能只靠 SW 的缓存名（v7/v8…）：那个只证明 **Service Worker 是新的**，
     证明不了**页面实际加载的 app.css / app.js 是新的** ——
     页面完全可能是「新 SW + 旧缓存快照」。所以诊断必须同时给出：
       ① 这行常量  → 证明 app.js 是新的
       ② #tabs 的 computed position → 证明 app.css 是新的（旧版是 static，v8 起是 fixed）
       ③ 底栏底 / 视口高 → 直接量「到底贴没贴底」，不靠肉眼判断 */
  var APP_BUILD = 'b30';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var ui = {
    tab: 'todo',
    sortMode: false,
    calY: 0, calM: 0, timeY: 0, timeM: 0,
    memoDirty: false,
    memoFocus: false,
    memoSaved: '',           // 上一次写进 store 的纯文本，用来判断「真的改了没」
    newTodoGroup: '',        // 新建待办/备注默认归到哪个分组（记住上次选的）
    lastSync: 0,             // 上次同步的时刻，用来给「回到前台自动同步」节流
    timeDragEnded: 0
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
    var previousFocus = document.activeElement;
    $('#sheet-body').innerHTML = html;
    var heading = $('#sheet-body h3');
    sh.setAttribute('aria-label', heading ? heading.textContent : '编辑内容');
    sh.removeAttribute('aria-hidden');
    sh.inert = false;
    sh.classList.add('on');
    $('#scrim').classList.add('on');
    sheetClose = function () {
      sh.classList.remove('on');
      $('#scrim').classList.remove('on');
      sh.setAttribute('aria-hidden', 'true');
      sh.inert = true;
      sheetClose = null;
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
    if (onMount) onMount($('#sheet-body'));
    sh.focus({ preventScroll: true });
  }

  function closeSheet() { closeRangePicker(); if (sheetClose) sheetClose(); }

  $('#scrim').addEventListener('click', closeSheet);
  $('#sheet-close').addEventListener('click', closeSheet);
  document.addEventListener('pointerdown', function (e) {
    var picker = $('.range-picker');
    if (picker && !picker.contains(e.target) && !e.target.closest('.range-date-trigger')) closeRangePicker();
  });
  document.addEventListener('keydown', function (e) {
    if (!sheetClose) return;
    var picker = $('.range-picker');
    if (picker && (e.key === 'Escape' || e.key === 'Tab')) {
      e.preventDefault(); var trigger = picker.trigger; closeRangePicker(); trigger.focus(); return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    var controls = $$('#sheet button, #sheet input, #sheet textarea, #sheet select, #sheet a[href]')
      .filter(function (x) { return !x.disabled && x.getClientRects().length; });
    if (!controls.length) { e.preventDefault(); return; }
    var first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === $('#sheet'))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });

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
    var buckets = Object.create(null), loose = [];
    st.groups.forEach(function (g) { buckets[g.id] = []; });
    st.todos.forEach(function (t) {
      if (buckets[t.group]) buckets[t.group].push(t);
      else loose.push(t);
    });
    var out = st.groups.map(function (g) {
      var items = buckets[g.id];
      return { g: g, items: items, done: items.filter(function (t) { return t.done; }).length };
    });
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

  var renderFrame = 0;
  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(function () { renderFrame = 0; render(); });
  }

  function updateHTML(el, html) {
    if (el._renderedHTML === html) return;
    var focused = document.activeElement;
    var scope = focused && el.contains(focused) ? focused.closest('[data-id], .ghead, [data-day]') : null;
    var scopeKey = scope ? (scope.dataset.id || scope.dataset.gid || scope.dataset.day || 'loose') : null;
    var roleClass = scope ? (focused.classList.contains('dot-check') ? '.dot-check' :
      focused.classList.contains('todo-edit') ? '.todo-edit' :
      focused.classList.contains('group-toggle') ? '.group-toggle' : focused.dataset.day ? 'self' : '') : '';
    el.innerHTML = html;
    el._renderedHTML = html;
    if (roleClass) {
      var nextScope = $$('[data-id], .ghead, [data-day]', el).find(function (x) {
        return (x.dataset.id || x.dataset.gid || x.dataset.day || 'loose') === scopeKey;
      });
      var nextFocus = nextScope && (roleClass === 'self' ? nextScope : $(roleClass, nextScope));
      if (nextFocus) nextFocus.focus({ preventScroll: true });
    }
  }

  function render() {
    if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
    renderHeader();
    if (ui.tab === 'todo') renderTodo();
    else if (ui.tab === 'time') renderTime(false);
    else if (ui.tab === 'meeting') renderTime(true);
    else if (ui.tab === 'cal') renderCal();
    else if (ui.tab === 'memo') renderMemo();
    else renderSet();
  }

  function renderHeader() {
    var titles = { todo: '待办', time: '月日历', meeting: '会议', cal: '日历', memo: '备忘', set: '设置' };
    $('#hdr-title').firstChild.nodeValue = titles[ui.tab];
    var sub = '';
    if (ui.tab === 'todo') {
      var n = S.state.todos.filter(function (t) { return !t.done; }).length;
      sub = n ? '剩 ' + n + ' 条' : '';
    }
    $('#hdr-sub').textContent = sub;

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
    h += '<button class="dot-check' + (t.done ? ' on' : '') + '" data-act="toggle" aria-pressed="' + !!t.done +
      '" aria-label="' + esc((t.done ? '取消完成：' : '完成：') + t.text) + '">✓</button>';
    h += '<button class="grow todo-edit" aria-label="' + esc('编辑：' + t.text + (t.note ? '，备注：' + t.note : '')) + '"><span class="txt">' + esc(t.text) + '</span>' +
      (t.note ? '<span class="todo-note"> · …</span>' : '') + '</button>';
    if (t.start_date) h += '<span class="todo-date">' + esc(t.start_date.slice(5)) + '</span>';
    h += '<span class="star s' + (t.star || 0) + '">' + stars(t.star) + '</span>';
    if (ui.sortMode) {
      h += '<button class="mv" data-act="up" aria-label="上移">▲</button>';
      h += '<button class="mv" data-act="dn" aria-label="下移">▼</button>';
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
    updateHTML($('#todo-tools'), tools);

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
          '<button class="group-toggle" aria-expanded="' + !grp.g.collapsed + '">' +
          '<svg class="tri' + (grp.g.collapsed ? ' folded' : '') + '" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>' +
          '<span class="gname">' + esc(grp.g.name || '未命名分组') + '</span></button>' +
          '<span class="gcount">' + grp.done + '/' + grp.items.length + '</span>' +
          '<button class="mv group-menu" data-act="gedit" aria-label="' + esc('编辑分组：' + grp.g.name) + '">⋯</button>' +
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
        '<button class="group-toggle" aria-expanded="' + !S.state.loose_collapsed + '">' +
        '<svg class="tri' + (S.state.loose_collapsed ? ' folded' : '') + '" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>' +
        '<span class="gname">未分组</span></button>' +
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
    updateHTML($('#todo-list'), h);
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

  function addTodo(text, group) {
    text = (text || '').trim();
    if (!text) {
      toast('先写一点内容');
      return false;
    }
    S.mutate(function (st) {
      st.todos.push({
        id: R.newId(), text: text, done: false, star: 0,
        group: group === undefined ? (ui.newTodoGroup || '') : group,
        done_at: '', start_date: '', end_date: '', extra_ranges: []
      });
    });
    return true;
  }

  /** 清掉历史版本或电脑端意外写入的空白待办。 */
  function removeBlankTodos() {
    var count = S.state.todos.filter(function (t) {
      return !String(t.text || '').trim();
    }).length;
    if (!count) return 0;
    S.mutate(function (st) {
      st.todos = st.todos.filter(function (t) { return String(t.text || '').trim(); });
    });
    return count;
  }

  /** 快速连续新增：成功后清空输入框，但始终保留键盘和光标。 */
  function submitQuickTodo(inp) {
    if (!addTodo(inp.value)) {
      inp.focus();
      return;
    }
    inp.value = '';
    try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
    requestAnimationFrame(function () {
      try { inp.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    });
  }

  /* ------------------------------------------------------------ 任务月历 */

  function isoDay(date) { return dayKey(date.getFullYear(), date.getMonth(), date.getDate()); }
  function shiftDay(key, days) {
    var d = new Date(key + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return isoDay(d);
  }
  function taskRanges(t) {
    var ranges = [];
    if (t.start_date && t.end_date) ranges.push({ start: t.start_date, end: t.end_date });
    (t.extra_ranges || []).forEach(function (r) {
      if (r && r.start && r.end) ranges.push({ start: r.start, end: r.end });
    });
    return ranges.sort(function (a, b) { return a.start.localeCompare(b.start); });
  }
  function setTaskRanges(t, ranges) {
    ranges.sort(function (a, b) { return a.start.localeCompare(b.start); });
    t.start_date = ranges.length ? ranges[0].start : '';
    t.end_date = ranges.length ? ranges[0].end : '';
    t.extra_ranges = ranges.slice(1).map(function (r) { return { start: r.start, end: r.end }; });
  }
  function rangeText(r) { return r.start.slice(5).replace('-', '/') + ' - ' + r.end.slice(5).replace('-', '/'); }
  function moveMonth(n) {
    if (!ui.timeY) { var d = new Date(); ui.timeY = d.getFullYear(); ui.timeM = d.getMonth(); }
    var target = new Date(ui.timeY, ui.timeM + n, 1);
    ui.timeY = target.getFullYear(); ui.timeM = target.getMonth();
    render();
  }
  function taskMonthHtml() {
    var y = ui.timeY, m = ui.timeM, count = new Date(y, m + 1, 0).getDate();
    var first = dayKey(y, m, 1), last = dayKey(y, m, count);
    var today = isoDay(new Date()), days = '', weekends = '';
    for (var d = 1; d <= count; d++) {
      var key = dayKey(y, m, d);
      var weekend = new Date(y, m, d).getDay() % 6 === 0;
      var notes = S.state.cal[key] || [], kinds = new Set(notes.map(function (x) { return x.kind === 'meeting' ? 'meeting' : 'event'; }));
      var ring = kinds.size === 2 ? ' mixed' : (kinds.has('meeting') ? ' meeting' : (kinds.has('event') ? ' event' : ''));
      days += '<button type="button" class="time-day' + (weekend ? ' weekend' : '') + (key === today ? ' today' : '') + ring +
        '" data-day="' + key + '" aria-label="' + key + (notes.length ? '，备注 ' + notes.length + ' 条' : '') + '">' + pad2(d) + '</button>';
      if (weekend) weekends += '<span class="time-weekend" style="grid-column:' + d + '"></span>';
    }
    var groups = plan(), sections = groups.groups.map(function (g) {
      return { name: g.g.name, items: visible(g.items) };
    });
    if (groups.loose.length) sections.push({ name: '未分组', items: visible(groups.loose) });
    var rows = '';
    sections.forEach(function (section) {
      var items = section.items.map(function (t) {
        return { task: t, ranges: taskRanges(t).map(function (r, slot) { return { start: r.start, end: r.end, slot: slot }; })
          .filter(function (r) { return r.start <= last && r.end >= first; }) };
      }).filter(function (item) { return item.ranges.length; });
      if (!items.length) return;
      rows += '<div class="time-section" style="--rows:' + items.length + '"><div class="time-group">' + esc(section.name) + '</div>';
      items.forEach(function (item) {
        var t = item.task;
        rows += '<div class="time-row">';
        item.ranges.forEach(function (r) {
          var start = Math.max(1, Math.round((new Date(r.start + 'T12:00:00') - new Date(first + 'T12:00:00')) / 86400000) + 1);
          var end = Math.min(count, Math.round((new Date(r.end + 'T12:00:00') - new Date(first + 'T12:00:00')) / 86400000) + 1);
          rows += '<button class="time-bar priority-' + (t.star || 0) + '" data-id="' + esc(t.id) + '" data-slot="' + r.slot +
            '" style="grid-column:' + start + '/span ' + (end - start + 1) + '" title="' + esc(t.text + ' · ' + rangeText(r)) +
            '" aria-label="编辑 ' + esc(t.text) + '，' + rangeText(r) + '">' +
            '<span class="time-grip" data-edge="start" aria-hidden="true"></span><span class="time-bar-text">' + esc(t.text) +
            '</span><span class="time-grip" data-edge="end" aria-hidden="true"></span></button>';
        });
        rows += '</div>';
      });
      rows += '</div>';
    });
    if (!rows) rows = '<div class="time-empty">这个月还没有设置任务时间。点任务后可填写开始和完成日期。</div>';
    var todayLine = today.slice(0, 7) === first.slice(0, 7) ?
      '<div class="time-now" style="left:calc(150px + ' + (Number(today.slice(8)) - 0.5) + ' * 44px)"></div>' : '';
    return '<div class="time-canvas" style="--days:' + count + '"><div class="time-weekends">' + weekends + '</div>' + todayLine +
      '<div class="time-header"><div class="time-month"><button data-month="-1" aria-label="上个月">‹</button><strong>' + y + '/' + pad2(m + 1) +
      '</strong><button data-month="1" aria-label="下个月">›</button></div><div class="time-days">' + days + '</div></div>' + rows + '</div>';
  }
  function meetingAxisHtml(p) {
    var now = new Date(), originDate = new Date(now), endDate = new Date(now);
    originDate.setHours(12, 0, 0, 0); endDate.setHours(12, 0, 0, 0);
    originDate.setDate(originDate.getDate() - 30); endDate.setDate(endDate.getDate() + 365);
    S.state.todos.forEach(function (t) { taskRanges(t).forEach(function (r) {
      var start = new Date(r.start + 'T12:00:00'), end = new Date(r.end + 'T12:00:00');
      start.setDate(start.getDate() - 4); end.setDate(end.getDate() + 7);
      if (start < originDate) originDate = start;
      if (end > endDate) endDate = end;
    }); });
    var origin = isoDay(originDate), last = isoDay(endDate);
    var count = Math.round((endDate - originDate) / 86400000) + 1;
    var head = '', shade = '', months = '', today = isoDay(new Date());
    for (var d = 0; d < count; d++) {
      var date = new Date(originDate.getFullYear(), originDate.getMonth(), originDate.getDate() + d);
      var key = isoDay(date), weekend = date.getDay() % 6 === 0;
      if (date.getDate() === 1) months += '<span class="meeting-axis-month" style="left:' + (d * 30 + 3) + 'px">' +
        date.getFullYear() + '.' + pad2(date.getMonth() + 1) + '</span>';
      head += '<button class="meeting-axis-day' + (weekend ? ' weekend' : '') + (key === today ? ' today' : '') +
        '" data-day="' + key + '" aria-label="' + key + '">' + pad2(date.getDate()) + '</button>';
      if (weekend) shade += '<span style="left:' + d * 30 + 'px"></span>';
    }
    function clipped(start, end) {
      if (start > last || end < origin) return null;
      var a = Math.max(0, Math.round((new Date(start + 'T12:00:00') - new Date(origin + 'T12:00:00')) / 86400000));
      var b = Math.min(count - 1, Math.round((new Date(end + 'T12:00:00') - new Date(origin + 'T12:00:00')) / 86400000));
      return { left: a * 30 + 2, width: (b - a + 1) * 30 - 4 };
    }
    function taskRow(t) {
      var bars = taskRanges(t).map(function (r, slot) {
        var pos = clipped(r.start, r.end);
        if (!pos) return '';
        return '<button class="time-bar meeting-axis-bar priority-' + (t.star || 0) + '" data-id="' + esc(t.id) +
          '" data-slot="' + slot + '" style="left:' + pos.left + 'px;width:' + pos.width + 'px" title="' +
          esc(t.text + ' · ' + rangeText(r)) + '" aria-label="编辑 ' + esc(t.text) + '，' + rangeText(r) + '">' +
          '<span class="time-grip" data-edge="start" aria-hidden="true"></span><span class="time-bar-text">' +
          esc(t.text) + '</span><span class="time-grip" data-edge="end" aria-hidden="true"></span></button>';
      }).join('');
      return '<div class="meeting-axis-row task" data-id="' + esc(t.id) + '">' + bars + '</div>';
    }
    function groupRow(items) {
      var segments = [];
      visible(items).forEach(function (t) {
        taskRanges(t).forEach(function (r, slot) {
          var pos = clipped(r.start, r.end);
          if (pos) segments.push({ task: t, range: r, slot: slot, pos: pos });
        });
      });
      if (!segments.length) return '<div class="meeting-axis-row group"></div>';
      var left = Math.min.apply(null, segments.map(function (x) { return x.pos.left; }));
      var right = Math.max.apply(null, segments.map(function (x) { return x.pos.left + x.pos.width; }));
      return '<div class="meeting-axis-row group"><span class="meeting-axis-summary" style="left:' + left + 'px;width:' +
        (right - left) + 'px"></span>' + segments.map(function (x) {
          return '<button class="meeting-axis-segment priority-' + (x.task.star || 0) + '" data-id="' + esc(x.task.id) +
            '" style="left:' + x.pos.left + 'px;width:' + x.pos.width + 'px" title="' +
            esc(x.task.text + ' · ' + rangeText(x.range)) + '">' + esc(x.task.text) + '</button>';
        }).join('') + '</div>';
    }
    var rows = '';
    p.groups.forEach(function (g) {
      rows += groupRow(g.items);
      if (!g.g.collapsed) rows += visible(g.items).map(taskRow).join('');
    });
    if (p.loose.length) {
      rows += groupRow(p.loose);
      if (!S.state.loose_collapsed) rows += visible(p.loose).map(taskRow).join('');
    }
    var todayOffset = Math.round((new Date(today + 'T12:00:00') - new Date(origin + 'T12:00:00')) / 86400000);
    return { origin: origin, days: count, todayOffset: todayOffset,
      head: '<div class="meeting-axis-head-inner" style="--axis-days:' + count + '">' + months +
        '<div class="meeting-axis-days">' + head + '</div></div>',
      body: '<div class="meeting-axis-canvas" style="--axis-days:' + count + '"><div class="meeting-axis-shading">' +
        shade + '</div>' + (todayOffset >= 0 && todayOffset < count ? '<div class="meeting-axis-now" style="left:' +
        (todayOffset * 30 + 15) + 'px"></div>' : '') + rows + '</div>' };
  }
  function renderTime(meeting) {
    if (!ui.timeY) { var d = new Date(); ui.timeY = d.getFullYear(); ui.timeM = d.getMonth(); }
    var toolbar = $('#' + (meeting ? 'meeting' : 'time') + '-toolbar');
    toolbar.innerHTML = '<button class="time-today" data-month="today">今天</button>' +
      '<button class="time-done" data-act="showdone">' + (S.cfg.showDone ? '隐藏已完成' : '显示已完成') + '</button>';
    var board = $('#' + (meeting ? 'meeting' : 'time') + '-board');
    var x = board.scrollLeft, yScroll = board.scrollTop;
    updateHTML(board, taskMonthHtml());
    board.scrollLeft = x; board.scrollTop = yScroll;
    if (meeting) {
      var p = plan(), list = '';
      p.groups.forEach(function (g) {
        list += '<div class="meeting-group" draggable="true" title="拖动调整分组顺序" data-gid="' + esc(g.g.id) + '"><button class="meeting-fold" aria-expanded="' + !g.g.collapsed +
          '" aria-label="' + (g.g.collapsed ? '展开' : '折叠') + esc(g.g.name) + '"><span class="meeting-arrow">' + (g.g.collapsed ? '▸' : '▾') +
          '</span><span class="meeting-name">' + esc(g.g.name) + '</span></button><span class="meeting-group-count">' + g.done + '/' + g.items.length +
          '</span><button data-act="group-add" aria-label="在' + esc(g.g.name) + '中新增任务">＋</button><button data-act="group-edit" aria-label="编辑' + esc(g.g.name) + '">⋯</button></div>' +
          (g.g.collapsed ? '' : visible(g.items).map(meetingTask).join(''));
      });
      if (p.loose.length) list += '<div class="meeting-group" data-gid=""><button class="meeting-fold" aria-expanded="' + !S.state.loose_collapsed +
        '"><span class="meeting-arrow">' + (S.state.loose_collapsed ? '▸' : '▾') + '</span><span class="meeting-name">未分组</span></button>' +
        '<span class="meeting-group-count">' + p.looseDone + '/' + p.loose.length + '</span><button data-act="group-add" aria-label="在未分组中新增任务">＋</button></div>' +
        (S.state.loose_collapsed ? '' : visible(p.loose).map(meetingTask).join(''));
      var taskList = $('#meeting-tasks'), taskScroll = taskList.scrollTop;
      updateHTML(taskList, list || '<div class="hint">还没有任务</div>');
      taskList.scrollTop = taskScroll;
      $('#meeting-count').textContent = p.groups.reduce(function (n, g) { return n + g.done; }, p.looseDone) + '/' + S.state.todos.length;
      var axis = $('#meeting-axis'), axisHead = $('#meeting-axis-head');
      var axisMarkup = meetingAxisHtml(p), sameOrigin = axis.dataset.origin === axisMarkup.origin;
      var axisX = axis.scrollLeft;
      updateHTML(axisHead, axisMarkup.head);
      updateHTML(axis, axisMarkup.body);
      axis.dataset.origin = axisMarkup.origin;
      axis.dataset.days = axisMarkup.days;
      axis.scrollLeft = sameOrigin ? axisX : Math.max(0, (axisMarkup.todayOffset - 5) * 30);
      axis.scrollTop = taskScroll;
      axisHead.scrollLeft = axis.scrollLeft;
    }
  }
  function meetingTask(t) {
    var level = Math.max(0, Math.min(3, t.star || 0));
    return '<div class="meeting-row" draggable="true" title="拖动调整任务顺序" data-id="' + esc(t.id) + '"><button data-act="toggle" aria-label="切换完成状态">' +
      (t.done ? '✓' : '○') + '</button><button class="meeting-edit">' + esc(t.text) + '</button>' +
      '<span class="meeting-priority priority-' + level + '" role="img" aria-label="' +
      ['普通', '重要', '很重要', '紧急'][level] + '" title="' + ['普通', '重要', '很重要', '紧急'][level] + '">' + stars(level) +
      '</span></div>';
  }
  function timeBoardPointer(event) {
    var bar = event.target.closest('.time-bar[data-id]');
    if (!bar || event.button !== 0) return;
    var task = S.state.todos.find(function (t) { return t.id === bar.dataset.id; });
    if (!task) return;
    var ranges = taskRanges(task), slot = Number(bar.dataset.slot), range = ranges[slot];
    if (!range) return;
    var step = bar.closest('#meeting-axis') ? 30 : 44;
    var edge = event.target.closest('[data-edge]');
    var mode = edge ? edge.dataset.edge : 'move', origin = event.clientX, delta = 0;
    bar.setPointerCapture(event.pointerId);
    bar.onpointermove = function (e) {
      delta = Math.round((e.clientX - origin) / step);
      bar.style.transform = mode === 'move' ? 'translateX(' + (delta * step) + 'px)' : '';
    };
    bar.onpointerup = function () {
      bar.onpointermove = bar.onpointerup = null;
      bar.style.transform = '';
      if (!delta) return;
      var start = mode === 'end' ? range.start : shiftDay(range.start, delta);
      var end = mode === 'start' ? range.end : shiftDay(range.end, delta);
      if (end < start) { toast('完成日期不能早于开始日期'); return; }
      ui.timeDragEnded = Date.now();
      S.mutate(function (st) { st.todos.forEach(function (t) {
        if (t.id === task.id) { var changed = taskRanges(t); changed[slot] = { start: start, end: end }; setTaskRanges(t, changed); }
      }); });
      render();
    };
  }

  /* ------------------------------------------------------------ 日历页 */

  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dayKey(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }

  function rangeDateField(value, label) {
    return '<input class="range-native" type="date" aria-label="' + label + '" value="' + esc(value || '') + '">' +
      '<button type="button" class="range-date-trigger" data-label="' + label + '" aria-label="' + label + '，' +
      (value ? esc(value.replace(/-/g, '/')) : '未选择') + '" aria-haspopup="dialog" aria-expanded="false">' +
      (value ? esc(value.replace(/-/g, '/')) : '选择日期') + '</button>';
  }

  function closeRangePicker() {
    var picker = $('.range-picker');
    if (!picker) return;
    if (picker.trigger) picker.trigger.setAttribute('aria-expanded', 'false');
    picker.remove();
  }

  function openRangePicker(trigger) {
    closeRangePicker();
    var input = trigger.previousElementSibling;
    var initial = input.value || dayKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    var selected = new Date(initial + 'T12:00:00');
    var y = selected.getFullYear(), m = selected.getMonth();
    var picker = document.createElement('div');
    picker.className = 'range-picker';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', '选择日期');
    picker.trigger = trigger;
    document.body.appendChild(picker);
    trigger.setAttribute('aria-expanded', 'true');

    function draw() {
      var value = dayKey(selected.getFullYear(), selected.getMonth(), selected.getDate());
      var first = new Date(y, m, 1), offset = (first.getDay() + 6) % 7;
      var start = new Date(y, m, 1 - offset), now = new Date();
      var today = dayKey(now.getFullYear(), now.getMonth(), now.getDate());
      var days = '';
      for (var i = 0; i < 42; i++) {
        var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        var key = dayKey(d.getFullYear(), d.getMonth(), d.getDate());
        var notes = S.state.cal[key] || [];
        var kinds = new Set(notes.map(function (x) { return x.kind === 'meeting' ? 'meeting' : 'event'; }));
        var ring = kinds.size === 2 ? ' mixed' : (kinds.has('meeting') ? ' meeting' : (kinds.has('event') ? ' event' : ''));
        days += '<button type="button" class="range-picker-day' + (d.getMonth() !== m ? ' out' : '') +
          (key === today ? ' today' : '') + (key === value ? ' selected' : '') + ring +
          '" data-pick-day="' + key + '" aria-label="' + key + '"' + (key === value ? ' aria-pressed="true"' : '') +
          '><span>' + d.getDate() + '</span></button>';
      }
      picker.innerHTML = '<div class="range-picker-nav"><button type="button" data-pick-month="-1" aria-label="上个月">‹</button>' +
        '<strong>' + value.replace(/-/g, '/') + '</strong><button type="button" data-pick-month="1" aria-label="下个月">›</button></div>' +
        '<div class="range-picker-grid">' + ['一', '二', '三', '四', '五', '六', '日'].map(function (w) { return '<span class="range-picker-week">' + w + '</span>'; }).join('') +
        days + '</div>';
      var rect = trigger.getBoundingClientRect();
      picker.style.left = Math.max(8, Math.min(rect.left, innerWidth - picker.offsetWidth - 8)) + 'px';
      picker.style.top = Math.max(8, rect.bottom + picker.offsetHeight + 8 <= innerHeight ? rect.bottom + 4 : rect.top - picker.offsetHeight - 4) + 'px';
    }
    picker.addEventListener('click', function (e) {
      var month = e.target.closest('[data-pick-month]');
      if (month) {
        var direction = month.dataset.pickMonth;
        var next = new Date(y, m + Number(direction), 1);
        y = next.getFullYear(); m = next.getMonth();
        selected = new Date(y, m, Math.min(selected.getDate(), new Date(y, m + 1, 0).getDate()));
        draw(); picker.querySelector('[data-pick-month="' + direction + '"]').focus(); return;
      }
      var day = e.target.closest('[data-pick-day]');
      if (day) {
        input.value = day.dataset.pickDay;
        trigger.textContent = input.value.replace(/-/g, '/');
        trigger.setAttribute('aria-label', trigger.dataset.label + '，' + trigger.textContent);
        closeRangePicker(); trigger.focus();
      }
    });
    draw();
    var active = picker.querySelector('.range-picker-day.selected');
    if (active) active.focus();
  }

  function renderCal() {
    if (!ui.calY) { var t = new Date(); ui.calY = t.getFullYear(); ui.calM = t.getMonth(); }
    var first = new Date(ui.calY, ui.calM, 1);
    var start = new Date(ui.calY, ui.calM, 1 - first.getDay());
    var today = new Date();
    var tkey = dayKey(today.getFullYear(), today.getMonth(), today.getDate());
    var monthKey = ui.calY + '-' + pad2(ui.calM + 1);
    var shownDay = ui.selDay && ui.selDay.slice(0, 7) === monthKey ? ui.selDay :
      (tkey.slice(0, 7) === monthKey ? tkey : monthKey + '-01');
    $('#cal-title').textContent = shownDay.replace(/-/g, '/');

    var h = '';
    WEEK.forEach(function (w) { h += '<div class="wk">' + w + '</div>'; });

    // {日期: 这天划掉了几项} —— 只在循环外扫一遍 todos，别在 42 个格子里各扫一次
    var finMap = {}, taskMap = {};
    S.state.todos.forEach(function (t) {
      if (t.done && t.done_at) finMap[t.done_at] = (finMap[t.done_at] || 0) + 1;
      if (t.done && !S.cfg.showDone) return;
      taskRanges(t).forEach(function (r) {
        for (var date = r.start, n = 0; date <= r.end && n < 370; date = shiftDay(date, 1), n++) {
          taskMap[date] = (taskMap[date] || 0) + 1;
        }
      });
    });

    for (var i = 0; i < 42; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var k = dayKey(d.getFullYear(), d.getMonth(), d.getDate());
      var out = d.getMonth() !== ui.calM;
      var notes = S.state.cal[k] || [], n = notes.length;
      var kinds = new Set(notes.map(function (x) { return x.kind === 'meeting' ? 'meeting' : 'event'; }));
      var ring = kinds.size === 2 ? ' mixed' : (kinds.has('meeting') ? ' meeting' : (kinds.has('event') ? ' event' : ''));
      var cls = 'd' + (out ? ' out' : '') + (d.getDay() % 6 === 0 ? ' weekend' : '') + (k === tkey ? ' today' : '') + (k === ui.selDay ? ' sel' : '');
      cls += ring;
      var label = k + (taskMap[k] ? '，计划任务 ' + taskMap[k] + ' 项' : '') + (n ? '，备注 ' + n + ' 条' : '') + (finMap[k] ? '，划掉 ' + finMap[k] + ' 项' : '');
      h += '<button class="' + cls + '" data-day="' + k + '" aria-label="' + label +
        '" aria-pressed="' + (k === ui.selDay) + '"' + (k === tkey ? ' aria-current="date"' : '') + '><span class="day-num">' + d.getDate() + '</span>' +
        (taskMap[k] ? '<span class="task-count">' + taskMap[k] + '</span>' : '') +
        (finMap[k] ? '<span class="fd"></span>' : '') + '</button>';
    }
    updateHTML($('#calgrid'), h);

    var monthPrefix = ui.calY + '-' + pad2(ui.calM + 1);
    var total = Object.keys(S.state.cal).filter(function (x) { return x.slice(0, 7) === monthPrefix && (S.state.cal[x] || []).length; }).length;
    $('#cal-hint').textContent = total
      ? '本月 ' + total + ' 天有备注，点日期查看或添加。'
      : '本月还没有备注，点日期就能添加。';
  }

  function openDay(key) {
    ui.selDay = key;
    renderCal();
    var d = new Date(key + 'T00:00:00');
    var title = d.getMonth() + 1 + '月' + d.getDate() + '日 · 周' + WEEK[d.getDay()];
    openSheet(
      '<h3>' + title + '</h3><div id="daylist"></div>' +
      '<div class="lbl">加一条</div>' +
      '<div style="display:flex;gap:8px"><input type="text" id="day-inp" aria-label="当天备注内容" placeholder="当天要做什么…" ' +
      'autocomplete="off" enterkeyhint="done"><select id="day-kind" aria-label="备注类别"><option value="event">事件</option><option value="meeting">内部会议</option></select>' +
      '<button class="addbtn" id="day-add">＋</button></div>',
      function (root) {
        drawDay(root, key);
        var inp = $('#day-inp', root);
        $('#day-add', root).addEventListener('click', function () { addDay(root, key, inp); });
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); addDay(root, key, inp); }
        });
      });
  }

  function drawDay(root, key) {
    var items = S.state.cal[key] || [];
    // 这天在待办清单里划掉的项目（和桌面 DayDialog 里那块对应）
    var fin = S.state.todos.filter(function (t) { return t.done && t.done_at === key; });
    var scheduled = S.state.todos.filter(function (t) {
      return taskRanges(t).some(function (r) { return r.start <= key && r.end >= key; });
    });
    var h = '';
    if (!items.length && !fin.length && !scheduled.length) h = '<div class="hint">这天还没有记录。</div>';
    if (scheduled.length) {
      h += '<div class="lbl">计划任务 · ' + scheduled.length + '</div>';
      scheduled.forEach(function (t) {
        h += '<button class="row tap day-task" data-task-id="' + esc(t.id) + '"><span class="txt">' + esc(t.text) + '</span><span class="sub">' +
          esc(taskRanges(t).filter(function (r) { return r.start <= key && r.end >= key; }).map(rangeText).join('、')) + '</span></button>';
      });
    }
    items.forEach(function (x) {
      var gname = '';
      S.state.groups.forEach(function (g) { if (g.id === x.group) gname = g.name; });
      h += '<div class="row' + (x.done ? ' done' : '') + '" data-cid="' + x.id + '">' +
        '<button class="dot-check' + (x.done ? ' on' : '') + '" data-act="ctoggle">✓</button>' +
        '<div class="grow"><div class="txt">' + esc(x.text) + '</div>' +
        (gname ? '<div class="sub">' + esc(gname) + '</div>' : '') + '</div>' +
        '<button class="event-kind ' + (x.kind === 'meeting' ? 'meeting' : 'event') +
        '" data-act="ckind" aria-label="切换事件和内部会议">' +
        (x.kind === 'meeting' ? '会议' : '事件') + '</button>' +
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
      st.cal[key].push({ id: R.newId(), text: v, group: ui.newTodoGroup || '', done: false,
        kind: $('#day-kind', root).value || 'event' });
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

    h += '<div class="setting-view-links"><div class="sec-t">查看方式</div><div class="card">' +
      '<a class="row tap view-link" href="?t=time">任务月日历<span class="chev">›</span></a>' +
      '<a class="row tap view-link" href="?t=meeting">会议网页版<span class="chev">›</span></a></div></div>';

    h += '<div class="sec-t">我的账号</div><div class="card">';
    var user = A.current();
    h += '<div class="row"><div class="grow"><div class="txt">' +
      (user ? esc(user.email) : '登录小浮窗') + '</div><div class="sub">' +
      (user ? (A.initializing && A.initializing() ? '正在恢复账号连接，先显示本机已保存的内容' :
        '当前内容保存在你的独立账号空间') : '登录后，在不同 iPhone 上同步自己的内容') +
      '</div></div><button class="hbtn" data-act="' + (user ? 'account-out' : 'account-in') + '">' +
      (user ? '退出' : '登录 / 注册') + '</button></div>';
    if (A.recovering()) h += '<button class="row tap install-guide" data-act="account-password">设置新密码</button>';
    if (!user) h += '<div class="row"><div class="sub">' +
      '当前为本机空间。登录后会打开独立空间；需要迁移时，先导出备份，再登录并导入。</div></div>';
    h += '<button class="row tap install-guide" data-act="install"><span class="grow">' +
      '<span class="txt">添加到 iPhone 主屏幕</span><span class="sub">安装步骤与分享给朋友</span>' +
      '</span><span class="chev">›</span></button></div>';

    if (user) {
      h += '<div class="sec-t">账号同步</div><div class="card"><div class="row">' +
        '<div class="grow"><div class="txt">自动同步</div><div class="sub">断网时先保存在本机，联网后继续同步</div></div>' +
        '<button class="hbtn" data-act="toggle-sync">' + (cfg.syncOn ? '已开启' : '已关闭') + '</button></div>' +
        '<div class="row"><div class="grow"><div class="txt">立即同步</div><div class="sub">' + syncMsg() +
        '</div></div><button class="hbtn" data-act="syncnow">同步</button></div></div>';
    } else {

    h += '<details class="legacy-sync"' + (GH.isSignedIn() ? ' open' : '') +
      '><summary>与旧版电脑同步（GitHub）</summary>';
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

    }

    if (!user) h += '</details>';
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
    h += '<div class="row tap" data-act="export"><div class="grow"><div class="txt">导出 / 分享备份</div>' +
      '<div class="sub">' + (cfg.lastBackupAt ? ('上次备份：' + esc(cfg.lastBackupAt)) : '存到“文件”或发给自己，可随时恢复') +
      '</div></div><span class="chev">›</span></div>';
    h += '<div class="row tap" data-act="import"><div class="grow"><div class="txt">从文件导入</div>' +
      '<div class="sub warn">会覆盖当前全部内容</div></div><span class="chev">›</span></div>';
    h += '<div class="row tap" data-act="wipe"><div class="grow"><div class="txt err">清空本机数据</div>' +
      '<div class="sub">只清本机缓存，云端内容不变</div></div><span class="chev">›</span></div>';
    h += '</div>';

    // ---- 关于
    h += '<div class="sec-t">关于</div><div class="card">';
    h += '<div class="row"><div class="grow"><div class="txt">小浮窗 · 手机版</div>' +
      '<div class="sub">' + (user ? '电脑端在设置中登录同一邮箱，即可同步此账号的内容。' : '新版电脑端支持邮箱账号同步；原有 GitHub 通道也可继续使用。') +
      '改动按「最后写入的赢」合并，' +
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

    if (!user && GH.isSignedIn()) h += '<div class="hint" style="padding-bottom:20px">' +
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
    var standalone = navigator.standalone === true ||
      (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    var target = Math.round(standalone ? window.screen.height : window.innerHeight);
    var d = target - b;
    out.push(b + '/' + target + (Math.abs(d) <= 1 ? ' ✓' : ' ✗' + d));
    if (standalone) out.push('页面 ' + Math.round(document.body.getBoundingClientRect().height) + '/' + target);
    return out.join(' · ');
  }

  function syncMsg() {
    if (!S.cfg.syncOn) return '同步没开';
    if (!S.canSync()) return S.accountId() ? '请重新登录' : '还没填 GitHub Token';
    var st = S.status;
    if (S.busy) return '正在同步…';
    if (st.ok === true) return '✓ 已同步 · ' + st.at + (st.pulled ? ' · 拉回 ' + st.pulled + ' 条' : '');
    if (st.ok === false) return '✗ ' + (st.error || '失败');
    return '还没同步过，点右边跑一次';
  }

  /* ---------------------------------------------------------------- 事件 */

  // 底部标签
  function switchTab(name) {
    if (!/^(todo|time|cal|memo|meeting|set)$/.test(name)) return;
    if (document.body.classList.contains('desktop-meeting') && name !== 'set') name = 'meeting';
    ui.tab = name;
    document.body.classList.toggle('meeting-mode', name === 'meeting');
    $$('#tabs button').forEach(function (x) {
      x.classList.toggle('on', x.dataset.tab === name);
      x.setAttribute('aria-current', x.dataset.tab === name ? 'page' : 'false');
    });
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
    submitQuickTodo($('#todo-inp'));
  });
  $('#todo-inp').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitQuickTodo(this);
    }
  });
  $('#todo-group').addEventListener('change', function () {
    ui.newTodoGroup = this.value;
  });

  ['time', 'meeting'].forEach(function (name) {
    var toolbar = $('#' + name + '-toolbar'), board = $('#' + name + '-board');
    toolbar.addEventListener('click', function (e) {
      var button = e.target.closest('button');
      if (!button) return;
      if (button.dataset.act === 'showdone') { S.saveCfg({ showDone: !S.cfg.showDone }); render(); return; }
      if (button.dataset.month === 'today') {
        var today = new Date(); ui.timeY = today.getFullYear(); ui.timeM = today.getMonth(); render();
        board.scrollLeft = Math.max(0, (today.getDate() - 3) * 44); return;
      }
      moveMonth(Number(button.dataset.month));
      board.scrollLeft = 0;
    });
    board.addEventListener('pointerdown', timeBoardPointer);
    board.addEventListener('click', function (e) {
      var monthButton = e.target.closest('[data-month]');
      if (monthButton) { moveMonth(Number(monthButton.dataset.month)); board.scrollLeft = 0; return; }
      var dayButton = e.target.closest('.time-day[data-day]');
      if (dayButton) { openDay(dayButton.dataset.day); return; }
      var bar = e.target.closest('.time-bar[data-id]');
      if (bar) { if (Date.now() - ui.timeDragEnded < 300) return; openTodoSheet(bar.dataset.id); }
    });
  });
  $('#meeting-tasks').addEventListener('click', function (e) {
    var group = e.target.closest('.meeting-group');
    if (group) {
      var gid = group.dataset.gid, action = e.target.closest('[data-act]');
      if (action && action.dataset.act === 'group-edit') { openGroupSheet(gid); return; }
      if (action && action.dataset.act === 'group-add') { openMeetingCreate(gid); return; }
      S.mutate(function (st) {
        if (!gid) st.loose_collapsed = !st.loose_collapsed;
        else st.groups.forEach(function (g) { if (g.id === gid) g.collapsed = !g.collapsed; });
      });
      render(); return;
    }
    var row = e.target.closest('[data-id]');
    if (!row) return;
    if (e.target.closest('[data-act="toggle"]')) {
      S.mutate(function (st) { st.todos.forEach(function (t) {
        if (t.id === row.dataset.id) { t.done = !t.done; t.done_at = t.done ? isoDay(new Date()) : ''; }
      }); });
      render();
    } else openTodoSheet(row.dataset.id);
  });
  $('#meeting-tasks').addEventListener('pointerdown', function (e) {
    var row = e.target.closest('.meeting-row[data-id]');
    if (!row) return;
    $$('.time-bar[data-id="' + CSS.escape(row.dataset.id) + '"]', $('#p-meeting')).forEach(function (bar) { bar.classList.add('linked'); });
  });
  document.addEventListener('pointerup', function () {
    $$('.time-bar.linked', $('#p-meeting')).forEach(function (bar) { bar.classList.remove('linked'); });
  });
  $('#meeting-tasks').addEventListener('scroll', function () { $('#meeting-axis').scrollTop = this.scrollTop; });
  $('#meeting-axis').addEventListener('scroll', function () {
    $('#meeting-tasks').scrollTop = this.scrollTop;
    $('#meeting-axis-head').scrollLeft = this.scrollLeft;
  });
  $('#meeting-axis-head').addEventListener('click', function (e) {
    var day = e.target.closest('[data-day]');
    if (day) openDay(day.dataset.day);
  });
  $('#meeting-axis-today').addEventListener('click', function () {
    var today = new Date();
    var axis = $('#meeting-axis'), origin = axis.dataset.origin;
    axis.scrollLeft = Math.max(0, (Math.round((new Date(isoDay(today) + 'T12:00:00') -
      new Date(origin + 'T12:00:00')) / 86400000) - 5) * 30);
  });
  $('#meeting-axis').addEventListener('pointerdown', timeBoardPointer);
  $('#meeting-axis').addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || e.target.closest('.time-bar, .meeting-axis-segment')) return;
    var row = e.target.closest('.meeting-axis-row.task[data-id]');
    if (!row) return;
    var axis = $('#meeting-axis'), count = Number(axis.dataset.days), origin = axis.dataset.origin;
    var indexAt = function (x) { return Math.max(0, Math.min(count - 1, Math.floor((x - row.getBoundingClientRect().left) / 30))); };
    var first = indexAt(e.clientX), last = first;
    var task = S.state.todos.find(function (t) { return t.id === row.dataset.id; });
    if (!task) return;
    var preview = document.createElement('span');
    preview.className = 'meeting-axis-preview priority-' + (task.star || 0);
    row.appendChild(preview);
    function draw() {
      preview.style.left = (Math.min(first, last) * 30 + 2) + 'px';
      preview.style.width = ((Math.abs(last - first) + 1) * 30 - 4) + 'px';
    }
    draw(); row.setPointerCapture(e.pointerId);
    row.onpointermove = function (move) { last = indexAt(move.clientX); draw(); };
    row.onpointercancel = function () { row.onpointermove = row.onpointerup = row.onpointercancel = null; preview.remove(); };
    row.onpointerup = function () {
      row.onpointermove = row.onpointerup = row.onpointercancel = null;
      preview.remove();
      var start = shiftDay(origin, Math.min(first, last)), end = shiftDay(origin, Math.max(first, last));
      S.mutate(function (st) { st.todos.forEach(function (t) {
        if (t.id === task.id) setTaskRanges(t, taskRanges(t).concat({ start: start, end: end }));
      }); });
      ui.timeDragEnded = Date.now(); render();
    };
  });
  $('#meeting-axis').addEventListener('click', function (e) {
    var bar = e.target.closest('.time-bar[data-id], .meeting-axis-segment[data-id]');
    if (bar && Date.now() - ui.timeDragEnded >= 300) openTodoSheet(bar.dataset.id);
  });
  var meetingDrag = null;
  $('#meeting-tasks').addEventListener('dragstart', function (e) {
    var item = e.target.closest('.meeting-row[data-id], .meeting-group[data-gid]');
    if (!item) return;
    meetingDrag = item.classList.contains('meeting-group') ? { type: 'group', id: item.dataset.gid } : { type: 'task', id: item.dataset.id };
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', meetingDrag.id);
  });
  $('#meeting-tasks').addEventListener('dragover', function (e) {
    if (!meetingDrag) return;
    var target = e.target.closest(meetingDrag.type === 'group' ? '.meeting-group[data-gid]' : '.meeting-row[data-id], .meeting-group[data-gid]');
    if (!target || (meetingDrag.type === 'group' && !target.dataset.gid)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    $$('.meeting-drag-target', $('#meeting-tasks')).forEach(function (x) { x.classList.remove('meeting-drag-target'); });
    target.classList.add('meeting-drag-target');
  });
  $('#meeting-tasks').addEventListener('drop', function (e) {
    if (!meetingDrag) return;
    var target = e.target.closest(meetingDrag.type === 'group' ? '.meeting-group[data-gid]' : '.meeting-row[data-id], .meeting-group[data-gid]');
    if (!target) return;
    e.preventDefault();
    var drag = meetingDrag; meetingDrag = null;
    if (drag.type === 'group') {
      if (!target.dataset.gid || target.dataset.gid === drag.id) return;
      S.mutate(function (st) {
        var from = st.groups.findIndex(function (g) { return g.id === drag.id; });
        if (from < 0) return;
        var moved = st.groups.splice(from, 1)[0];
        var to = st.groups.findIndex(function (g) { return g.id === target.dataset.gid; });
        st.groups.splice(to, 0, moved);
      });
    } else {
      if (target.dataset.id === drag.id) return;
      S.mutate(function (st) {
        var from = st.todos.findIndex(function (t) { return t.id === drag.id; });
        if (from < 0) return;
        var moved = st.todos.splice(from, 1)[0];
        if (target.classList.contains('meeting-group')) {
          moved.group = target.dataset.gid || '';
          var end = -1;
          st.todos.forEach(function (t, i) { if (t.group === moved.group) end = i; });
          st.todos.splice(end + 1, 0, moved);
        } else {
          var to = st.todos.findIndex(function (t) { return t.id === target.dataset.id; });
          if (to < 0) { st.todos.splice(from, 0, moved); return; }
          moved.group = st.todos[to].group;
          st.todos.splice(to, 0, moved);
        }
      });
    }
    render();
  });
  $('#meeting-tasks').addEventListener('dragend', function () {
    meetingDrag = null;
    $$('.meeting-drag-target', $('#meeting-tasks')).forEach(function (x) { x.classList.remove('meeting-drag-target'); });
    $$('.time-bar.linked', $('#p-meeting')).forEach(function (bar) { bar.classList.remove('linked'); });
  });
  function openMeetingCreate(groupId) {
    openSheet('<h3>新增任务</h3><label class="lbl" for="meeting-new">任务名称</label><input id="meeting-new" type="text">' +
      '<div style="height:16px"></div><button class="btn" id="meeting-create">创建并设置时间</button>', function (root) {
      $('#meeting-create', root).addEventListener('click', function () {
        if (!addTodo($('#meeting-new', root).value, groupId || '')) return;
        var id = S.state.todos[S.state.todos.length - 1].id;
        closeSheet(); openTodoSheet(id);
      });
      $('#meeting-new', root).addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#meeting-create', root).click(); }
      });
    });
  }
  $('#meeting-add').addEventListener('click', function () { openMeetingCreate(''); });
  $('#meeting-new-group').addEventListener('click', askNewGroup);
  $('#meeting-settings').addEventListener('click', function () { switchTab('set'); });
  $('#meeting-back').addEventListener('click', function () { switchTab('meeting'); });

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
    var taskButton = e.target.closest('[data-task-id]');
    if (taskButton) { openTodoSheet(taskButton.dataset.taskId); return; }

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
    } else if (a === 'ckind') {
      S.mutate(function (st) {
        (st.cal[key] || []).forEach(function (x) {
          if (x.id === id) x.kind = x.kind === 'meeting' ? 'event' : 'meeting';
        });
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
    if (a === 'account-in') {
      openAccountSheet('login');
    } else if (a === 'account-password') {
      openAccountSheet('password');
    } else if (a === 'install') {
      openInstallGuide();
    } else if (a === 'account-out') {
      confirmSheet('退出账号', '退出后会回到本机空间。此账号的内容会保留在本机独立缓存和云端；尚未同步的改动请先点“立即同步”。',
        '退出账号', function () {
          if (ui.memoDirty) saveMemo();
          closeSheet();
          A.signOut().then(function () { toast('已退出账号'); }).catch(function (e) { toast(e.message, 5000); });
        });
    } else if (a === 'toggle-sync') {
      S.saveCfg({ syncOn: !S.cfg.syncOn });
      renderSet();
      if (S.cfg.syncOn && S.canSync()) doSync();
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
      confirmSheet('清空本机数据', '只清当前空间在这台手机上的待办 / 日历 / 备忘。云端不受影响，下次同步还会拉回来。',
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
      '<input type="text" id="e-text" aria-label="待办内容" value="' + esc(t.text) + '">' +
      '<label class="lbl" for="e-note">备注</label><textarea id="e-note" rows="3" placeholder="给这项添加备注">' + esc(t.note || '') + '</textarea>' +
      '<div class="lbl">时间段</div><div id="e-ranges"></div><button type="button" class="btn ghost" id="e-add-range">＋ 增加时间段</button>' +
      '<label class="lbl" for="e-group">分组</label><select id="e-group">' + opts + '</select>' +
      '<div class="lbl">重要程度</div>' +
      '<div style="display:flex;gap:8px">' +
      [0, 1, 2, 3].map(function (n) {
        return '<button class="btn priority-' + n + (n === (t.star || 0) ? '' : ' ghost') + '" data-star="' + n +
          '" aria-label="' + ['普通', '重要', '很重要', '紧急'][n] + '">' +
          stars(n) + '</button>';
      }).join('') + '</div>' +
      '<div style="height:16px"></div>' +
      '<button class="btn" id="e-save">保存</button>' +
      '<div style="height:8px"></div>' +
      '<button class="btn danger" id="e-del">删除</button>',
      function (root) {
        var star = t.star || 0;
        function drawRanges() {
          var ranges = taskRanges(t);
          $('#e-ranges', root).innerHTML = ranges.map(function (r, i) {
            return '<div class="edit-range" data-range="' + i + '">' + rangeDateField(r.start, '第 ' + (i + 1) + ' 段开始日期') +
              '<span>—</span>' + rangeDateField(r.end, '第 ' + (i + 1) + ' 段完成日期') +
              '<button type="button" class="range-remove" aria-label="删除第 ' + (i + 1) + ' 段">×</button></div>';
          }).join('');
        }
        drawRanges();
        $('#e-add-range', root).addEventListener('click', function () {
          $('#e-ranges', root).insertAdjacentHTML('beforeend', '<div class="edit-range">' + rangeDateField('', '新时间段开始日期') +
            '<span>—</span>' + rangeDateField('', '新时间段完成日期') + '<button type="button" class="range-remove" aria-label="删除这一段">×</button></div>');
        });
        $('#e-ranges', root).addEventListener('click', function (e) {
          var trigger = e.target.closest('.range-date-trigger');
          if (trigger) { openRangePicker(trigger); return; }
          if (e.target.closest('.range-remove')) { closeRangePicker(); e.target.closest('.edit-range').remove(); }
        });
        $$('[data-star]', root).forEach(function (b) {
          b.addEventListener('click', function () {
            star = parseInt(b.dataset.star, 10);
            $$('[data-star]', root).forEach(function (x) {
              x.className = 'btn priority-' + x.dataset.star + (parseInt(x.dataset.star, 10) === star ? '' : ' ghost');
            });
          });
        });
        $('#e-save', root).addEventListener('click', function () {
          var txt = $('#e-text', root).value.trim();
          var grp = $('#e-group', root).value;
          var ranges = [], invalid = false;
          $$('.edit-range', root).forEach(function (row) {
            var inputs = row.querySelectorAll('input'), start = inputs[0].value, end = inputs[1].value;
            if (!start && !end) return;
            if (!start || !end || end < start) invalid = true;
            else ranges.push({ start: start, end: end });
          });
          if (!txt) { toast('内容不能为空'); return; }
          if (invalid) { toast('请填写完整时间段，且完成日期不早于开始日期'); return; }
          S.mutate(function (st) {
            st.todos.forEach(function (x) {
               if (x.id === id) { x.text = txt; x.note = $('#e-note', root).value.trim(); x.group = grp; x.star = star; setTaskRanges(x, ranges); }
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

  function openInstallGuide() {
    openSheet('<h3>把小浮窗放到主屏幕</h3><ol class="install-steps">' +
      '<li>在 iPhone 的 Safari 中打开小浮窗。</li><li>点分享按钮，选择“添加到主屏幕”。</li>' +
      '<li>如果显示“作为网页 App 打开”，保持开启，再点“添加”。</li>' +
      '<li>从主屏幕图标打开，在“设置”登录自己的账号。</li></ol>' +
      '<p class="hint">朋友用自己的邮箱注册，账号内容各自保存。新版 Windows 小浮窗在设置中登录同一邮箱，即可与手机同步；首次登录可合并电脑原有内容。</p>' +
      '<button class="btn" id="share-app">分享给朋友</button><p class="hint" id="share-result" role="status"></p>',
      function (root) {
        $('#share-app', root).addEventListener('click', function () {
          var url = location.origin + location.pathname;
          if (navigator.share) navigator.share({ title: '小浮窗', text: '自己的待办、日历和备忘', url: url })
            .catch(function (e) { if (e.name !== 'AbortError') $('#share-result', root).textContent = '请复制浏览器中的网页地址分享。'; });
          else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () {
            $('#share-result', root).textContent = '链接已复制，发给朋友即可。';
          }).catch(function () { $('#share-result', root).textContent = url; });
          else $('#share-result', root).textContent = url;
        });
      });
  }

  function openAccountSheet(mode) {
    var titles = { login: '登录小浮窗', register: '创建账号', recover: '找回密码', password: '设置新密码' };
    if (!A.configured()) {
      openSheet('<h3>账号服务准备中</h3><p class="hint">管理员尚未完成云端配置。你可以继续使用本机功能；账号开通后，在这里注册和登录。</p>');
      return;
    }
    var passwordOnly = mode === 'password', registering = mode === 'register';
    var emailOnly = mode === 'recover';
    var h = '<h3>' + titles[mode] + '</h3><p class="hint">' +
      (passwordOnly ? '请设置至少 8 位的新密码。' : emailOnly ? '我们会向邮箱发送重置密码的链接。' :
        '用自己的邮箱保存待办、日历和备忘。登录不会自动合并本机空间里的内容。') + '</p>' +
      '<form id="account-form">';
    if (!passwordOnly) h += '<label class="lbl" for="account-email">邮箱</label>' +
      '<input id="account-email" type="email" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" required maxlength="254">';
    if (!emailOnly) h += '<label class="lbl" for="account-password">' + (passwordOnly ? '新密码' : '密码') + '</label>' +
      '<input id="account-password" type="password" autocomplete="' + (registering || passwordOnly ? 'new-password' : 'current-password') +
      '" required minlength="' + (registering || passwordOnly ? '8' : '1') + '" maxlength="128">';
    if (registering || passwordOnly) h += '<label class="lbl" for="account-repeat">再次输入密码</label>' +
      '<input id="account-repeat" type="password" autocomplete="new-password" required minlength="8" maxlength="128">';
    h += '<p id="account-result" class="hint account-result" role="status" aria-live="polite"></p>' +
      '<button class="btn" type="submit">' + (mode === 'login' ? '登录' : registering ? '注册' : emailOnly ? '发送重置邮件' : '保存新密码') + '</button></form>';
    if (!passwordOnly) h += '<div class="account-links">' +
      (mode !== 'login' ? '<button class="hbtn" data-mode="login">返回登录</button>' :
        '<button class="hbtn" data-mode="register">创建账号</button><button class="hbtn" data-mode="recover">忘记密码？</button>') + '</div>';
    h += '<p class="hint">登录凭据由 Supabase 管理。内容保存在本机及你的云端账号中，请在自己的设备上使用。</p>';
    openSheet(h, function (root) {
      var form = $('#account-form', root), result = $('#account-result', root);
      $$('[data-mode]', root).forEach(function (button) {
        button.addEventListener('click', function () { openAccountSheet(button.dataset.mode); });
      });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var email = $('#account-email', root), password = $('#account-password', root), repeat = $('#account-repeat', root);
        if (repeat && repeat.value !== password.value) {
          result.classList.add('err'); result.textContent = '两次密码不一致，请重新输入。'; repeat.focus(); return;
        }
        if (ui.memoDirty) saveMemo();
        var controls = $$('button, input', root);
        controls.forEach(function (el) { el.disabled = true; });
        result.classList.remove('err'); result.textContent = '正在处理…';
        Promise.resolve().then(function () {
          if (passwordOnly) return A.updatePassword(password.value);
          if (emailOnly) return A.recover(email.value.trim());
          return registering ? A.signUp(email.value.trim(), password.value) : A.signIn(email.value.trim(), password.value);
        }).then(function (data) {
          if (!root.isConnected || $('#account-form') !== form) return;
          if (emailOnly || (registering && !data.session)) {
            result.textContent = emailOnly ? '如果邮箱已注册，会收到重置邮件，请检查收件箱和垃圾邮件。' :
              '请检查邮箱中的确认邮件。确认后返回小浮窗登录；已注册的邮箱可以直接登录或找回密码。';
            return;
          }
          closeSheet(); render();
          if (registering) {
            openSheet('<h3>注册成功，已登录</h3><p class="hint">你的账号已可以使用。待办、日历和备忘会保存到这个账号；电脑端登录同一邮箱即可同步。</p><button class="btn" id="account-start">开始使用</button>', function (panel) {
              $('#account-start', panel).addEventListener('click', closeSheet);
            });
          } else toast(passwordOnly ? '密码已更新' : '已登录，正在同步自己的内容');
          if (S.cfg.syncOn && S.canSync()) doSync();
        }).catch(function (error) {
          result.classList.add('err'); result.textContent = error.message || '操作未完成，请重试。';
        }).finally(function () {
          controls.forEach(function (el) { el.disabled = false; });
        });
      });
    });
  }

  var accountSyncTimer = null;
  function queueAccountSync() {
    clearTimeout(accountSyncTimer);
    var id = S.accountId();
    if (!id || !S.cfg.syncOn || !S.canSync()) return;
    accountSyncTimer = setTimeout(function run() {
      if (id !== S.accountId() || !S.cfg.syncOn || !S.canSync() || navigator.onLine === false) return;
      if (S.busy) { accountSyncTimer = setTimeout(run, 1200); return; }
      S.sync().catch(function () { /* 设置页保留失败原因；本机改动留待重试。 */ });
    }, 1500);
  }

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
      var removed = removeBlankTodos();
      render();
      toast(removed ? ('已清理 ' + removed + ' 条空白任务') :
        (r.pulled ? ('同步完成 · 拉回 ' + r.pulled + ' 条') : '同步完成 · 没有新东西'));
    }).catch(function (e) {
      render();
      toast('同步失败：' + e.message, 5000);
    });
  }

  function doExport() {
    var name = '小浮窗备份 ' + R.stamp().replace(/[: ]/g, '-') + '.json';
    var json = S.exportJson();
    var blob = new Blob([json], { type: 'application/json' });
    var file = null;
    try { file = new File([json], name, { type: 'application/json' }); } catch (e) {}

    // iPhone / iPad 优先打开系统分享面板，可直接“存储到文件”或发给自己。
    if (file && navigator.share && navigator.canShare) {
      try {
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: '小浮窗数据备份' }).then(function () {
            S.saveCfg({ lastBackupAt: R.stamp() });
            toast('备份已分享');
          }).catch(function (e) {
            if (e && e.name === 'AbortError') return;
            downloadBackup(blob, name);
          });
          return;
        }
      } catch (e) { /* 不支持文件分享时走普通下载 */ }
    }
    downloadBackup(blob, name);
  }

  function downloadBackup(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    S.saveCfg({ lastBackupAt: R.stamp() });
    toast('备份已保存');
  }

  function doImport() {
    var targetAccount = S.accountId();
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          if (targetAccount !== S.accountId()) throw new Error('账号已切换，请重新选择备份文件。');
          var text = String(rd.result);
          var doc = JSON.parse(text);
          var raw = doc && doc.state ? doc.state : doc;
          if (!raw || !Array.isArray(raw.todos) || !Array.isArray(raw.groups) ||
              !raw.cal || typeof raw.cal !== 'object') {
            throw new Error('不是有效的小浮窗备份文件');
          }
          var preview = R.normalizeState(raw);
          var dayCount = Object.keys(preview.cal).length;
          var detail = '文件：' + esc(f.name) + '<br>待办 ' + preview.todos.length +
            ' 条，分组 ' + preview.groups.length + ' 个，日历 ' + dayCount +
            ' 天。导入后会覆盖当前全部内容。';
          confirmSheet('确认导入备份', detail, '导入并覆盖', function () {
            if (targetAccount !== S.accountId()) { closeSheet(); toast('账号已切换，已取消导入。'); return; }
            S.importJson(text);
            closeSheet(); render(); toast('备份已恢复');
          });
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
    if (m) m.setAttribute('content', dark ? '#1C1C1E' : '#FFFDF3');
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    S.load();
    var initialUser = A.current();
    if (initialUser) S.switchAccount(initialUser.id);
    var removedBlankTodos = removeBlankTodos();

    // ⚠⚠ 一次性数据修补（2026-10-19）：`done_at` 是 2026-10-17 才加上的字段，
    //   在那之前划掉的条目只有 done:true、没有完成日期 → 日历上**永远不显示**。
    //   toto 确认「合同拆分」「收据」两项是 10-16 划掉的，按他给的日子补上。
    //   ⚠ 必须打标记：否则他以后取消勾选（done_at 被清空）会被强行改回 10-16。
    //   ⚠ 只有真补上了才打标记 —— 首次装 App 时状态还是空的，别把机会用掉。
    try {
      if (!S.accountId() && !localStorage.getItem('fw_fix_done_at_v1')) {
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
    var colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    var onColorSchemeChange = function () {
      if (S.cfg.theme === 'auto') applyTheme('auto');
    };
    if (colorScheme.addEventListener) colorScheme.addEventListener('change', onColorSchemeChange);
    else if (colorScheme.addListener) colorScheme.addListener(onColorSchemeChange);

    // 从主屏图标的长按菜单进来时可能带着 ?t=cal 这种，先认一下
    var q0;
    try { q0 = new URLSearchParams(location.search); } catch (e) { q0 = null; }
    var wantTab = q0 && q0.get('t');
    var desktopMeeting = window.matchMedia('(min-width: 800px)');
    document.body.classList.toggle('desktop-meeting', desktopMeeting.matches);
    if (desktopMeeting.matches) switchTab('meeting');
    else if (wantTab) switchTab(wantTab);
    function resizeMeeting(e) {
      document.body.classList.toggle('desktop-meeting', e.matches);
      if (e.matches) switchTab('meeting');
      else if (ui.tab === 'meeting') switchTab('todo');
    }
    if (desktopMeeting.addEventListener) desktopMeeting.addEventListener('change', resizeMeeting);
    else if (desktopMeeting.addListener) desktopMeeting.addListener(resizeMeeting);

    var seenVersion = S.version;
    S.subscribe(function () {
      if (!ui.memoFocus) scheduleRender();
      if (S.version !== seenVersion) { seenVersion = S.version; queueAccountSync(); }
    });
    function accountChanged(user, event) {
      var id = user && user.id || '';
      if (id !== S.accountId()) {
        if (ui.memoDirty) saveMemo();
        clearTimeout(memoTimer); clearTimeout(accountSyncTimer);
        ui.memoDirty = false; ui.memoFocus = false; ui.memoSaved = ''; ui.newTodoGroup = '';
        ui.lastSync = 0;
        S.switchAccount(id);
        ui.memoSaved = htmlToText(S.state.memo_html);
        $('#memo').value = ui.memoSaved;
        $('#todo-inp').value = '';
        applyTheme(S.cfg.theme);
        // 用户在其他标签页登录时也关闭旧空间的编辑器，防止保存到新账号。
        var accountForm = $('#account-form');
        if (!accountForm) closeSheet();
        render();
        if (id) queueAccountSync();
      }
      if (event === 'PASSWORD_RECOVERY') setTimeout(function () { openAccountSheet('password'); }, 0);
    }
    A.subscribe(accountChanged);
    A.ready.then(function () {
      accountChanged(A.current(), 'SESSION_READY');
      render();
      queueAccountSync();
    }).catch(function (error) {
      render();
      toast('账号连接暂未完成，本机内容仍可使用。' + (error.message || ''), 6000);
    });
    window.addEventListener('online', queueAccountSync);
    if (A.recovering()) openAccountSheet('password');

    // ⚠ 启动时顺手验一次 Token（把登录名取回来显示）。失败不弹错 ——
    //   手机可能只是暂时没网，等真去同步时再报。
    if (!S.accountId() && GH.isSignedIn() && !GH.getCfg().user) {
      GH.verify().then(function () { if (ui.tab === 'set') renderSet(); })
        .catch(function () {});
    }

    render();
    if (removedBlankTodos) toast('已清理 ' + removedBlankTodos + ' 条空白任务');
    if (S.cfg.syncOn && S.canSync()) {
      S.sync().then(function (r) {
        ui.lastSync = Date.now();
        var removed = removeBlankTodos();
        render();
        if (removed) toast('已清理 ' + removed + ' 条空白任务');
        else if (r.pulled) toast('已拉回 ' + r.pulled + ' 条');
      }).catch(function (e) { render(); toast('同步失败：' + e.message, 4000); });
    }

    // 回到前台时顺手同步一次。
    // ⚠ 不做后台轮询（手机上没有可靠的定时器，还费电），只在「切回前台」这个
    //   明确时机跑；并且 60 秒内不重复跑，免得来回切 App 时反复打网络。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!S.cfg.syncOn || !S.canSync() || S.busy) return;
      if (Date.now() - ui.lastSync < 60000) return;
      S.sync().then(function (r) {
        ui.lastSync = Date.now();
        var removed = removeBlankTodos();
        render();
        if (removed) toast('已清理 ' + removed + ' 条空白任务');
        else if (r.pulled) toast('已拉回 ' + r.pulled + ' 条');
      }).catch(function () { render(); });
    });

    // Safari 地址栏与主屏 App 的视口底边分别测量。
    // 浏览器工具栏用 --vv-gap；主屏模式的屏幕缺口用 --pwa-gap。
    // 高于 140px 的 visualViewport 缺口通常来自键盘，不移动底栏。
    var vvTimer = 0;
    var pwaGap = 0;
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

      // 主屏幕 App：部分 iOS 版本把 fixed 底栏画在屏幕底部之上。
      // screen.height 是物理屏幕的 CSS 像素高；扣掉底栏原本的底边。
      // 底栏与页面高度都延伸同样距离，让按钮和输入区一起下移。
      // 减去已应用值避免重复测量时振荡。
      var standalone = navigator.standalone === true ||
        (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
      var tabs = document.getElementById('tabs');
      var next = 0;
      if (standalone && tabs && window.screen && window.screen.height) {
        var originalBottom = tabs.getBoundingClientRect().bottom - pwaGap;
        next = Math.round(window.screen.height - originalBottom);
        if (next < 12 || next > 120) next = 0;
      }
      pwaGap = next;
      document.documentElement.style.setProperty('--pwa-gap', pwaGap + 'px');
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
        tabsEl.style.bottom = 'calc(0px - var(--pwa-gap, 0px))';
        tabsEl.style.paddingBottom = 'var(--vv-gap, 0px)';
        tabsEl.style.background = 'var(--card)';
        tabsEl.style.backdropFilter = 'none';
        tabsEl.style.webkitBackdropFilter = 'none';
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

  function start() {
    try {
      // 本机内容先显示；令牌刷新和云端恢复不能阻塞整个界面。
      boot();
      if (window.FW_STARTUP) window.FW_STARTUP.done();
    } catch (error) {
      if (window.FW_STARTUP) window.FW_STARTUP.fail('页面未能完成加载，请重新打开。本机数据没有清除。');
      console.error('[startup]', error);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // ⚠ 给探针用的后门：这两个转换函数是「两端数据不漂移」的关键，
  //   必须能被自动化测试单独调用（见 softwork/_probe/_memo_roundtrip.py）。
  window.__fw = { htmlToText: htmlToText, textToHtml: textToHtml };
})();
