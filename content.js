/* 双击关标签 — 内容脚本
 *
 * 只做一件事：判断这一次双击是否应该翻译成「关掉当前标签」，然后让后台去关。
 * 判断逻辑放在内容脚本里，是因为只有它能看见 DOM（焦点在哪个输入框、有没有选中文字）。
 */
(() => {
  const BUILD = '1.2.0';

  /* 重新注入时先拆掉自己上一次装的监听。
   *
   * 这里曾经用 `if (window.__x) return` 来防重复注入，结果埋了个坑：
   * 扩展更新（点「重新加载」）后，旧的内容脚本还挂在页面上，但它的
   * chrome.runtime 已经失效，消息发不出去；此时后台补注入新脚本，
   * 新脚本看到旧标记就提前退出 —— 页面上只剩一个死监听，双击毫无反应。
   * 所以现在改成：不因为有旧标记就退出，而是找到上一实例、拆掉它、装上新的。
   */
  const prev = window.__dblclickCloseTab;
  if (prev && typeof prev.destroy === 'function') {
    try {
      prev.destroy();
    } catch (_) {
      /* 旧实例本身坏掉了就更该继续往下装 */
    }
  }
  // 老版本留下的布尔标记只是噪音，清掉以免干扰判断
  window.__dblclickCloseTabLoaded = true;

  const DEFAULTS = { enabled: true, mode: 'smart', bypass: [], debugToast: false, dblclickMs: 400 };
  let cfg = { ...DEFAULTS };

  /** 扩展被重载后，旧内容脚本的 chrome.runtime 会失效，此时做任何事都没意义 */
  function alive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /* ---------- 配置 ---------- */

  function normalizeBypass(list) {
    return (Array.isArray(list) ? list : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
  }

  /* 双击间隔上限。
   *
   * 浏览器原生 dblclick 的判定阈值由操作系统决定（Windows 默认 500ms），页面脚本
   * 改不了，也不该改。于是这里干脆不用原生 dblclick：自己配对两次 mousedown，
   * 间隔小于 dblclickMs 才算一次双击。这样用户要的「自定义间隔」才有可能实现，
   * 顺便也绕开了「系统设置比我想要的慢/快」的问题。
   */
  const MS_MIN = 120;
  const MS_MAX = 1000;

  function normalizeMs(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULTS.dblclickMs;
    return Math.min(MS_MAX, Math.max(MS_MIN, Math.round(n)));
  }

  function applyConfig(raw) {
    cfg = { ...DEFAULTS, ...(raw || {}) };
    cfg.bypass = normalizeBypass(cfg.bypass);
    cfg.dblclickMs = normalizeMs(cfg.dblclickMs);
  }

  function readConfig() {
    try {
      chrome.storage.sync.get(DEFAULTS, (v) => {
        void chrome.runtime.lastError;
        applyConfig(v);
      });
    } catch (_) {
      /* 上下文已失效，保持默认配置 */
    }
  }

  readConfig();

  function onStorageChanged(changes, area) {
    if (area !== 'sync') return;
    const next = { ...cfg };
    for (const [key, { newValue }] of Object.entries(changes)) next[key] = newValue;
    applyConfig(next);
  }

  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch (_) {
    /* 同上 */
  }

  function hostBypassed() {
    const host = location.hostname.toLowerCase();
    return cfg.bypass.some((d) => host === d || host.endsWith('.' + d));
  }

  /* ---------- 该不该关 ---------- */

  const SKIP_TAGS = new Set([
    'input', 'textarea', 'select', 'option', 'video', 'audio',
    'canvas', 'svg', 'iframe', 'object', 'embed',
  ]);

  // 富文本编辑器 / 代码编辑器：双击是它们自己的选中单词手势
  const SKIP_SELECTORS = [
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    '.monaco-editor', '.cm-editor', '.CodeMirror', '.ace_editor',
    '.ProseMirror', '.ql-editor', '.DraftEditor-root', '.milkdown',
    '.excalidraw', '[data-lexical-editor]',
  ].join(',');

  // 双击在这些东西上是页面自己的语义（打开链接、切开关、放大图片……）
  const INTERACTIVE_SELECTORS = [
    'a', 'button', 'summary', 'label',
    '[role="button"]', '[role="link"]', '[role="menuitem"]',
    '[role="tab"]', '[role="checkbox"]', '[role="switch"]', '[role="radio"]',
    '[onclick]', '[draggable="true"]',
  ].join(',');

  function inEditable(el) {
    return Boolean(el.closest(SKIP_SELECTORS));
  }

  function hasTextSelection() {
    const sel = window.getSelection();
    return Boolean(sel && !sel.isCollapsed && String(sel).trim().length > 0);
  }

  /* 返回 null 表示该关；否则返回一句「为什么没关」，调试模式下会显示给用户。
   * 「无法双击关闭」是最难自查的一类问题，把原因说出来比让用户猜强。
   *
   * selectionBefore 由双击配对逻辑传进来：必须是「第一次点击之前」的选区状态，
   * 因为第二次 mousedown 时浏览器已经把词选好了。 */
  function skipReason(ev, selectionBefore) {
    if (!cfg.enabled) return '扩展已停用';
    if (hostBypassed()) return '当前站点已豁免';
    // 按住修饰键的双击是刻意操作，不去抢
    if (ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return '按住了修饰键';

    const target = ev.target instanceof Element ? ev.target : ev.target && ev.target.parentElement;
    if (!target) return '找不到双击目标';

    // 输入类控件：双击是选词，绝不能关页面
    const tag = target.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return `命中了 <${tag}> 控件`;
    if (inEditable(target)) return '命中了编辑器';

    if (cfg.mode !== 'anywhere') {
      if (selectionBefore) return '双击前已有选中文字';
      if (target.closest(INTERACTIVE_SELECTORS)) return '命中了可交互元素';
    }

    return null;
  }

  /* ---------- 双击配对（自己算间隔，不用浏览器原生的 dblclick） ---------- */

  /* 原生 dblclick 的等待上限由系统设定决定（Windows 默认 500ms），页面脚本拿不到、
   * 也改不了。所以这里自己配对两次 mousedown：间隔 <= cfg.dblclickMs 才算双击。
   *
   * 另一个必须自己配对的理由：「双击前已有选中文字就不关」这条判断依赖
   * 「双击开始前」的选区状态，而浏览器在第二次 mousedown 时就已经把词选好了，
   * 到 dblclick 阶段再看 getSelection() 必然非空。所以在第一次 mousedown 上取快照。
   */
  let pending = null; // { t, x, y, selectionBefore }

  // 两次点击位置差太多就不算同一次双击（防止按住拖选时误判）
  const SAME_SPOT = 12;

  function onMouseDown(ev) {
    // 扩展重载后的残留脚本：自己摘掉监听，别挡着新注入的实例
    if (!alive()) {
      destroy();
      return;
    }
    if (ev.button !== 0) return; // 只认左键

    const now = ev.timeStamp;
    const sameSpot =
      pending && Math.abs(ev.clientX - pending.x) <= SAME_SPOT && Math.abs(ev.clientY - pending.y) <= SAME_SPOT;
    const matched = sameSpot && now - pending.t <= cfg.dblclickMs;

    if (!matched) {
      // 记下这一次，等下一次点击来配对
      pending = { t: now, x: ev.clientX, y: ev.clientY, selectionBefore: hasTextSelection() };
      return;
    }

    const selectionBefore = pending.selectionBefore;
    pending = null;

    // 双击本身已经让浏览器选好了词，所以「有没有选中文字」只能看第一次点击前的快照
    const why = skipReason(ev, selectionBefore);
    if (why) {
      if (cfg.debugToast) toast(why);
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: 'dblclick-close' }, (res) => {
        if (chrome.runtime.lastError) {
          if (cfg.debugToast) toast('后台无响应，试着重载扩展');
          return; // 扩展已更新/页面已关，忽略
        }
        if (!res || res.ok) return;
        if (res.reason === 'last-tab') toast('已保留最后一个标签页');
        else if (cfg.debugToast) toast(`没关成：${res.reason}`);
      });
    } catch (_) {
      /* 扩展刚被重新加载，本次双击直接放弃 */
    }
  }

  let destroyed = false;

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try {
      window.removeEventListener('mousedown', onMouseDown, true);
    } catch (_) {}
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch (_) {}
    if (window.__dblclickCloseTab === api) delete window.__dblclickCloseTab;
  }

  const api = { build: BUILD, destroy, alive };

  // 捕获阶段监听：页面自己的 mousedown 处理器没法把这个事件藏起来
  window.addEventListener('mousedown', onMouseDown, true);

  /* ---------- 轻提示（只在没关成功时出现，比如最后一个标签） ---------- */

  let toastEl = null;
  let toastTimer = 0;

  function toast(text) {
    try {
      if (!toastEl) {
        const host = document.createElement('div');
        host.style.cssText =
          'all:initial;position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
        const shadow = host.attachShadow({ mode: 'closed' });
        const box = document.createElement('div');
        box.style.cssText = [
          'font:13px/1.4 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
          'color:#fff',
          'background:rgba(24,26,32,.92)',
          'padding:8px 14px',
          'border-radius:999px',
          'box-shadow:0 6px 24px rgba(0,0,0,.28)',
          'opacity:0',
          'transition:opacity .16s ease',
          'white-space:nowrap',
        ].join(';');
        shadow.appendChild(box);
        host.__box = box;
        (document.body || document.documentElement).appendChild(host);
        toastEl = host;
      }
      const box = toastEl.__box;
      box.textContent = text;
      box.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        box.style.opacity = '0';
      }, 1400);
    } catch (_) {
      /* 页面禁止插入节点就算了，不打扰用户 */
    }
  }

  /* ---------- 主流程 ---------- */

  /* 上面的 onMouseDown 在配对成功时已经做完判断与发消息，所以这里没有 dblclick
   * 处理函数 —— 不是漏写。原生 dblclick 的阈值改不了，留着它反而会和自定义间隔打架。 */

  // 给后台/弹窗留一个探针，用来回答「这个页面到底注入成功没有」
  window.__dblclickCloseTab = api;

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'dblclick-ping') return undefined;
      sendResponse({ ok: true, build: BUILD });
      return undefined;
    });
  } catch (_) {
    /* 上下文失效，探针自然也不会被调用 */
  }
})();
