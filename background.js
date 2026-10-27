/* 双击关标签 — 后台 service worker
 *
 * 内容脚本只负责判断「这一下双击该不该算」，真正的关标签动作在这里做：
 * 内容脚本所在的网页上下文没有 chrome.tabs 权限，也不应该拿到。
 */

const DEFAULTS = {
  enabled: true,
  mode: 'smart', // smart：跳过选中文字与输入控件；anywhere：任何位置都关
  keepLastTab: true, // 窗口里只剩一个标签时不关，避免连窗口一起没了
  bypass: [], // 站点豁免，域名后缀列表
};

function getConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(DEFAULTS, (v) => {
        void chrome.runtime.lastError; // 未登录同步时可能报错，退回默认值即可
        resolve({ ...DEFAULTS, ...(v || {}) });
      });
    } catch (_) {
      resolve({ ...DEFAULTS });
    }
  });
}

async function closeTab(tabId, windowId) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };

  if (cfg.keepLastTab) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ windowId });
    } catch (_) {
      tabs = [];
    }
    if (tabs.length <= 1) return { ok: false, reason: 'last-tab' };
  }

  try {
    await chrome.tabs.remove(tabId);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'remove-failed', message: String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'dblclick-close') return undefined;

  const tab = sender.tab;
  if (!tab || tab.id == null) {
    sendResponse({ ok: false, reason: 'no-tab' });
    return true;
  }

  closeTab(tab.id, tab.windowId).then(sendResponse, (err) =>
    sendResponse({ ok: false, reason: 'error', message: String(err) }),
  );
  return true; // 异步回复
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});
