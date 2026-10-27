/* 双击关标签 — 工具栏弹窗 */

const DEFAULTS = { enabled: true, mode: 'smart', keepLastTab: true, bypass: [] };
const $ = (id) => document.getElementById(id);

let currentHost = '';

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

function flash(text) {
  const el = $('status');
  el.textContent = text;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => {
    el.textContent = '';
  }, 1500);
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

async function init() {
  const cfg = await load();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentHost = tab && tab.url ? new URL(tab.url).hostname.toLowerCase() : '';
  } catch (_) {
    currentHost = '';
  }

  $('enabled').checked = cfg.enabled !== false;

  const bypass = (cfg.bypass || []).map((s) => String(s).toLowerCase());
  $('bypassHere').checked = Boolean(currentHost) && bypass.some((d) => hostMatches(currentHost, d));
  $('bypassHere').disabled = !currentHost;
  $('bypassHere').closest('.row').title = currentHost || '当前页面不能豁免（chrome:// 等内部页面）';

  $('enabled').addEventListener('change', async (e) => {
    await save({ enabled: e.target.checked });
    flash(e.target.checked ? '已启用' : '已停用');
  });

  $('bypassHere').addEventListener('change', async (e) => {
    const now = await load();
    const list = (now.bypass || []).map((s) => String(s).toLowerCase());
    let next;
    if (e.target.checked) {
      next = [...new Set([...list, currentHost])];
    } else {
      next = list.filter((d) => !hostMatches(currentHost, d));
    }
    await save({ bypass: next });
    flash(e.target.checked ? '本页已豁免' : '已取消豁免');
  });

  $('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

document.addEventListener('DOMContentLoaded', init);
