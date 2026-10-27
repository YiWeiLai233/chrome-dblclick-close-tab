/* 双击关标签 — 设置页 */

const DEFAULTS = { enabled: true, mode: 'smart', keepLastTab: true, bypass: [], debugToast: false };

const $ = (id) => document.getElementById(id);

function load() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (v) => {
      void chrome.runtime.lastError;
      resolve({ ...DEFAULTS, ...(v || {}) });
    });
  });
}

function save(patch) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(patch, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function linesToArray(text) {
  return String(text)
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 把 commands.getAll() 的结果渲染成「Alt+Shift+W」这样的可读文本 */
async function renderShortcut() {
  const el = $('shortcut');
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find((c) => c.name === 'close-current-tab');
    if (!cmd || !cmd.shortcut) {
      // 快捷键为空通常是被别的扩展或系统占用了
      el.textContent = '未设置（可能被其他扩展占用，请到 chrome://extensions/shortcuts 重设）';
      return;
    }
    el.textContent = cmd.shortcut
      .replace(/MacCtrl|Command/gi, '⌘')
      .replace(/Ctrl/gi, 'Ctrl')
      .replace(/Alt/gi, 'Alt')
      .replace(/Shift/gi, 'Shift');
  } catch (_) {
    el.textContent = '读取失败';
  }
}

async function render() {
  const cfg = await load();
  $('enabled').checked = cfg.enabled !== false;
  $('keepLastTab').checked = cfg.keepLastTab !== false;
  $('debugToast').checked = cfg.debugToast === true;
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === (cfg.mode === 'anywhere' ? 'anywhere' : 'smart');
  });
  $('bypass').value = (cfg.bypass || []).join('\n');
  $('status').textContent = '';
  await renderShortcut();
}

function flash(text) {
  const el = $('status');
  el.textContent = text;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => {
    el.textContent = '';
  }, 1600);
}

document.addEventListener('DOMContentLoaded', async () => {
  await render();

  $('enabled').addEventListener('change', async (e) => {
    await save({ enabled: e.target.checked });
    flash(e.target.checked ? '已启用' : '已停用');
  });

  $('keepLastTab').addEventListener('change', async (e) => {
    await save({ keepLastTab: e.target.checked });
    flash('已保存');
  });

  $('debugToast').addEventListener('change', async (e) => {
    await save({ debugToast: e.target.checked });
    flash(e.target.checked ? '已开启，双击试试' : '已关闭');
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      await save({ mode: r.value });
      flash('已保存');
    });
  });

  $('saveBypass').addEventListener('click', async () => {
    const bypass = linesToArray($('bypass').value);
    await save({ bypass });
    $('bypass').value = bypass.join('\n');
    flash(`已保存 ${bypass.length} 条豁免规则`);
  });

  $('reset').addEventListener('click', async () => {
    await save({ ...DEFAULTS });
    await render();
    flash('已恢复默认设置');
  });
});
