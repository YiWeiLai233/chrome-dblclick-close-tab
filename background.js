/* 双击关标签 — 后台 service worker
 *
 * 内容脚本只负责判断「这一下双击该不该算」，真正的关标签动作在这里做：
 * 内容脚本所在的网页上下文没有 chrome.tabs 权限，也不应该拿到。
 *
 * 另外一个职责是「让已经开着的标签也能用」：扩展装上/更新后，之前就在的页面
 * 里并没有新的内容脚本，用户不会想到先去刷新，只会觉得「装了没用」。
 */

const DEFAULTS = {
  enabled: true,
  mode: 'smart', // smart：跳过选中文字与输入控件；anywhere：任何位置都关
  keepLastTab: true, // 窗口里只剩一个标签时不关，避免连窗口一起没了
  bypass: [], // 站点豁免，域名后缀列表
};

const INJECTABLE = /^https?:\/\//i;

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

/* 页面里那份内容脚本还活着吗？版本对不对？
 *
 * 扩展重载之后，旧页面里的内容脚本还挂着监听，但它的 chrome.runtime 已经失效，
 * 双击发不出消息 —— 表现就是「更新了扩展，双击还是没反应」。所以不能只看
 * 「注入过没有」，要看「注入的那一份现在还喘气吗」。
 *
 * 光看「喘气」还不够：升级到新版本后，旧脚本活得好好的，probe 返回 true，
 * 补注入就被跳过了，页面里跑的仍然是老逻辑（比如不支持自定义双击间隔）。
 * 所以把它的 BUILD 和清单版本比一比，不一致就重新注入。
 */
async function probe(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const api = window.__dblclickCloseTab;
        if (!api || typeof api.alive !== 'function' || !api.alive()) return null;
        return typeof api.build === 'string' ? api.build : '';
      },
    });
    return r ? r.result : null; // null 表示没有可用脚本；字符串是它的版本
  } catch (_) {
    return null; // 注入不进去（chrome://、商店页、被策略禁用）就当没有
  }
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (_) {
    return false;
  }
}

/** 保证某个标签里跑的是当前版本的内容脚本；返回是否真的注入了 */
async function ensureInjected(tabId) {
  if (tabId == null) return false;
  const build = await probe(tabId);
  if (build === chrome.runtime.getManifest().version) return false;
  return inject(tabId);
}

/** 把所有普通网页标签补一遍 */
async function injectAll() {
  if (!chrome.scripting || !chrome.scripting.executeScript) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {
    return;
  }
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded) continue;
    if (!INJECTABLE.test(tab.url || '')) continue;
    await ensureInjected(tab.id);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;

  if (msg.type === 'dblclick-close') {
    const tab = sender.tab;
    if (!tab || tab.id == null) {
      sendResponse({ ok: false, reason: 'no-tab' });
      return true;
    }
    closeTab(tab.id, tab.windowId).then(sendResponse, (err) =>
      sendResponse({ ok: false, reason: 'error', message: String(err) }),
    );
    return true; // 异步回复
  }

  // 弹窗/设置页点开时顺手把当前页修一遍，给用户一条不用刷新页面的自救路径
  if (msg.type === 'ensure-inject') {
    (async () => {
      let tabId = msg.tabId;
      if (tabId == null) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab && tab.id;
      }
      const injected = await ensureInjected(tabId);
      sendResponse({ ok: true, injected });
    })();
    return true;
  }

  if (msg.type === 'inject-all') {
    injectAll().then(() => sendResponse({ ok: true }));
    return true;
  }

  return undefined;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  injectAll();
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  injectAll();
});

/* 快捷键通道。
 *
 * 为什么需要它：浏览器扩展拿不到标签栏（tab strip）上的鼠标事件 —— 那是浏览器
 * 自己的 UI，不在任何扩展能监听的范围内（Firefox 有 tabs.closeTabByDblclick，
 * Chrome/Edge 没有对应能力）。所以「在标签栏双击关闭」这件事，纯扩展做不到。
 * 能替代的是浏览器级快捷键：commands 由浏览器自己派发，不受页面脚本干扰，
 * 在页面、弹窗、开发者工具里都生效。
 */
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'close-current-tab') return;
  closeActiveTab();
});

async function closeActiveTab() {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (_) {
    return;
  }
  if (!tab || tab.id == null) return;
  await closeTab(tab.id, tab.windowId);
}

/* 兜底自愈：页面加载完成后确认一下脚本还在。
 * 正常情况下清单里的 content_scripts 已经注入了，probe 会返回 true，什么都不做；
 * 只有真的缺了才补一次。代价是每个页面一次极轻的 executeScript。 */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!INJECTABLE.test(tab.url || '')) return;
  ensureInjected(tabId);
});
