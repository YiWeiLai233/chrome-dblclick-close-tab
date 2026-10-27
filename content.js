/* 双击关标签 — 内容脚本
 *
 * 只做一件事：判断这一次双击是否应该翻译成「关掉当前标签」，然后让后台去关。
 * 判断逻辑放在内容脚本里，是因为只有它能看见 DOM（焦点在哪个输入框、有没有选中文字）。
 */
(() => {
  if (window.__dblclickCloseTabLoaded) return;
  window.__dblclickCloseTabLoaded = true;

  const DEFAULTS = { enabled: true, mode: 'smart', bypass: [] };
  let cfg = { ...DEFAULTS };

  /* ---------- 配置 ---------- */

  function normalizeBypass(list) {
    return (Array.isArray(list) ? list : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
  }

  function applyConfig(raw) {
    cfg = { ...DEFAULTS, ...(raw || {}) };
    cfg.bypass = normalizeBypass(cfg.bypass);
  }

  try {
    chrome.storage.sync.get(DEFAULTS, (v) => {
      void chrome.runtime.lastError;
      applyConfig(v);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const next = { ...cfg };
      for (const [key, { newValue }] of Object.entries(changes)) next[key] = newValue;
      applyConfig(next);
    });
  } catch (_) {
    /* 扩展被重新加载后旧的 content script 会失去 chrome.*，静默降级为默认配置 */
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

  // 双击本身就会选中一个词：浏览器在第二次 mousedown 时已经把选区做好，
  // 到 dblclick 阶段再查 getSelection() 必然非空。所以要在「双击开始前」
  // 的那次 mousedown（detail === 1）上取快照，否则一次都关不掉。
  let selectionBeforeDblclick = false;

  function snapshotSelection(ev) {
    if (ev.detail !== 1) return;
    selectionBeforeDblclick = hasTextSelection();
  }

  function shouldClose(ev) {
    if (!cfg.enabled || hostBypassed()) return false;
    if (ev.defaultPrevented) return false;
    // 按住修饰键的双击是刻意操作，不去抢
    if (ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return false;

    const target = ev.target instanceof Element ? ev.target : ev.target && ev.target.parentElement;
    if (!target) return false;

    // 输入类控件：双击是选词，绝不能关页面
    const tag = target.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return false;
    if (inEditable(target)) return false;

    if (cfg.mode !== 'anywhere') {
      if (selectionBeforeDblclick) return false;
      if (target.closest(INTERACTIVE_SELECTORS)) return false;
    }

    return true;
  }

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

  function onDblClick(ev) {
    if (!shouldClose(ev)) return;
    try {
      chrome.runtime.sendMessage({ type: 'dblclick-close' }, (res) => {
        if (chrome.runtime.lastError) return; // 扩展已更新/页面已关，忽略
        if (!res || res.ok) return;
        if (res.reason === 'last-tab') toast('已保留最后一个标签页');
      });
    } catch (_) {
      /* 扩展刚被重新加载，本次双击直接放弃 */
    }
  }

  // 捕获阶段监听：页面自己的 dblclick 处理器没法把这个事件藏起来
  window.addEventListener('mousedown', snapshotSelection, true);
  window.addEventListener('dblclick', onDblClick, true);
})();
