/* 双击关标签 — 设置页 */

const DEFAULTS = { enabled: true, mode: 'smart', keepLastTab: true, bypass: [] };

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

async function render() {
  const cfg = await load();
  $('enabled').checked = cfg.enabled !== false;
  $('keepLastTab').checked = cfg.keepLastTab !== false;
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === (cfg.mode === 'anywhere' ? 'anywhere' : 'smart');
  });
  $('bypass').value = (cfg.bypass || []).join('\n');
  $('status').textContent = '';
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
