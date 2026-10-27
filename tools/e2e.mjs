/* 端到端验证：真的把扩展装进 Chrome，用 CDP 派发真实双击，看标签有没有关。
 *
 * 注意：Chrome 137+ 起 `--load-extension` / `--disable-extensions-except`
 * 在正式版里会被直接忽略（stderr 报 "is not allowed in Google Chrome"），
 * 所以这里改用 CDP 的浏览器级命令 Extensions.loadUnpacked 装载扩展。
 *
 * 覆盖：
 *   1. 正文双击          → 关
 *   2. 链接上双击        → 不关（智能模式）
 *   3. 输入框里双击      → 不关
 *   4. 代码编辑器里双击  → 不关
 *   5. 有选中文字时双击  → 不关
 *   6. 只剩一个标签时双击 → 不关（保留最后标签）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXT = resolve(import.meta.dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_PORT = 9321;
const CDP_PORT = 9322;

const PAGE = `<!doctype html><meta charset="utf-8">
<title>dblclick test</title>
<style>
  body{margin:0;font:16px/1.6 system-ui;padding:0}
  #text{padding:40px 20px;height:120px}
  #link{display:block;padding:20px;width:200px}
  #input{margin:20px;padding:10px;width:200px;font-size:16px}
  #editor{margin:20px;padding:10px;min-height:60px;border:1px solid #ccc}
  #code{margin:20px;padding:10px;min-height:60px;border:1px solid #ccc;font-family:monospace}
</style>
<div id="text">普通正文，双击这里应该关闭标签。</div>
<a id="link" href="https://example.com/">这是一个链接</a>
<input id="input" value="输入框里的文字">
<div id="editor" contenteditable="true">可编辑富文本</div>
<div id="code" class="monaco-editor">伪代码编辑器</div>
`;

function serve() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((r) => server.listen(APP_PORT, '127.0.0.1', () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return res.json();
}

async function newTab(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  return res.json();
}

class Session {
  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((r) => this.ws.addEventListener('open', r, { once: true }));
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
        return;
      }
      for (const fn of this.listeners) fn(m);
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  async send(method, params = {}) {
    await this.ready;
    const mid = ++this.id;
    this.ws.send(JSON.stringify({ id: mid, method, params }));
    return new Promise((res) => this.pending.set(mid, res));
  }
  async evaluate(expression, contextId) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** 在页面坐标 (x,y) 处派发一次真实双击 */
async function doubleClick(s, x, y) {
  const base = { x, y, button: 'left' };
  await s.send('Input.dispatchMouseEvent', { ...base, buttons: 1, clickCount: 1, type: 'mousePressed' });
  await s.send('Input.dispatchMouseEvent', { ...base, buttons: 0, clickCount: 1, type: 'mouseReleased' });
  await s.send('Input.dispatchMouseEvent', { ...base, buttons: 1, clickCount: 2, type: 'mousePressed' });
  await s.send('Input.dispatchMouseEvent', { ...base, buttons: 0, clickCount: 2, type: 'mouseReleased' });
}

async function openAndAttach(url) {
  const tab = await newTab(url);
  const s = new Session(tab.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await sleep(700); // 等 content script 注入
  return { tab, s };
}

async function centerOf(s, selector) {
  return s.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
}

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function tabAlive(id) {
  const list = await cdpTargets();
  return list.some((t) => t.id === id && t.type === 'page');
}

/** 关掉扩展安装后自动打开的 options 页，避免干扰「最后一个标签」用例 */
async function closeExtensionTabs() {
  const list = await cdpTargets();
  for (const t of list) {
    if (t.type === 'page' && t.url.startsWith('chrome-extension://')) {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${t.id}`);
      await sleep(200);
    }
  }
}

/** 除指定标签外，关掉所有标签页（含扩展页）。用于构造「只剩一个标签」的场景。 */
async function closeOthers(keepId) {
  const list = (await cdpTargets()).filter((t) => t.type === 'page' && t.id !== keepId);
  for (const t of list) {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${t.id}`);
    await sleep(150);
  }
  await sleep(500);
  return (await cdpTargets()).filter((t) => t.type === 'page').map((t) => t.id);
}

async function main() {
  const server = await serve();
  const profile = mkdtempSync(join(tmpdir(), 'dct-profile-'));
  const logPath = join(profile, 'chrome-stderr.log');
  const logFd = openSync(logPath, 'w');

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1000,800',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', logFd] },
  );

  chrome.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`chrome exited code=${code} signal=${signal}（详见 ${logPath}）`);
  });

  // 等 CDP 起来
  let version = null;
  for (let i = 0; i < 80; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error('CDP 没起来，Chrome 可能启动失败');

  const base = `http://127.0.0.1:${APP_PORT}/`;

  // 先开一个页面，再装扩展：模拟「扩展装好之前就开着的标签」。
  // 这类标签里没有 content script，必须靠 background 的补注入才能双击生效，
  // 否则用户装完扩展发现双击没反应。
  const preTab = await newTab(base);
  await sleep(300);

  // 用浏览器级 CDP 装载未打包扩展
  const browser = new Session(version.webSocketDebuggerUrl);
  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
  if (!loaded.result?.id) {
    throw new Error(`Extensions.loadUnpacked 失败：${JSON.stringify(loaded.error)}`);
  }
  console.log(`扩展已装载 id=${loaded.result.id}`);
  await sleep(2000); // 等 onInstalled 补注入跑完
  await closeExtensionTabs();

  try {
    // 常驻标签，保证被测标签不是窗口里唯一的那个
    await newTab('about:blank');
    await sleep(400);

    // 0. 扩展装之前就开着的标签 → 补注入之后也应能双击关闭
    {
      const s = new Session(preTab.webSocketDebuggerUrl);
      await s.send('Runtime.enable');
      await sleep(300);
      const p = await centerOf(s, '#text');
      await doubleClick(s, p.x, p.y);
      await sleep(700);
      const alive = await tabAlive(preTab.id);
      record('装扩展前已打开的标签也能双击关闭', !alive, alive ? '补注入没生效' : '');
      s.close();
    }

    // 1. 正文双击 → 关
    {
      const { tab, s } = await openAndAttach(base);
      const p = await centerOf(s, '#text');
      await doubleClick(s, p.x, p.y);
      await sleep(700);
      const alive = await tabAlive(tab.id);
      record('正文双击关闭标签', !alive, alive ? '标签仍然存在' : '');
      s.close();
    }

    // 2. 链接上双击 → 不关
    {
      const { tab, s } = await openAndAttach(base);
      const p = await centerOf(s, '#link');
      await doubleClick(s, p.x, p.y);
      await sleep(700);
      const alive = await tabAlive(tab.id);
      record('链接上双击不关闭', alive, alive ? '' : '标签被误关');
      s.close();
    }

    // 3. 输入框里双击 → 不关
    {
      const { tab, s } = await openAndAttach(base);
      const p = await centerOf(s, '#input');
      await doubleClick(s, p.x, p.y);
      await sleep(700);
      const alive = await tabAlive(tab.id);
      record('输入框双击不关闭', alive, alive ? '' : '标签被误关');
      s.close();
    }

    // 4. contenteditable / 代码编辑器 → 不关
    for (const sel of ['#editor', '#code']) {
      const { tab, s } = await openAndAttach(base);
      const p = await centerOf(s, sel);
      await doubleClick(s, p.x, p.y);
      await sleep(700);
      const alive = await tabAlive(tab.id);
      record(`${sel} 双击不关闭`, alive, alive ? '' : '标签被误关');
      s.close();
    }

    // 5. 双击前已有选中文字 → 不关
    {
      const { tab, s } = await openAndAttach(base);
      await s.evaluate(`(() => {
        const el = document.querySelector('#text');
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      })()`);
      const p = await centerOf(s, '#text');
      await doubleClick(s, p.x, p.y);
      await sleep(700);
      const alive = await tabAlive(tab.id);
      record('选中文字后双击不关闭', alive, alive ? '' : '标签被误关');
      s.close();
    }

    // 6. 只剩一个标签 → 保留
    {
      // 前面每个用例只断了 WebSocket，标签还开着。要测「保留最后标签」，
      // 必须真的把窗口收到只剩被测的这一个。
      const { tab, s } = await openAndAttach(base);
      const remaining = await closeOthers(tab.id);
      console.log(`  开测前窗口内标签数：${remaining.length}`);
      record('能构造出单标签窗口', remaining.length === 1, `实际 ${remaining.length} 个`);

      const p = await centerOf(s, '#text');
      await doubleClick(s, p.x, p.y);
      await sleep(800);
      // 标签没了就连带窗口一起退，evaluate 会挂；先可靠地确认存活，再碰 DOM
      const alive = await tabAlive(tab.id);
      record('最后一个标签不被关闭', alive, alive ? '' : '窗口被一起关掉了');

      if (alive) {
        const hasBody = await s.evaluate('!!document.body');
        record('页面仍可交互', hasBody === true);
      } else {
        record('页面仍可交互', false, '标签已消失，无法检查');
      }
      s.close();
    }
  } finally {
    browser.close();
    chrome.kill();
    server.close();
    const keep = process.env.KEEP_PROFILE === '1' || results.some((r) => !r.pass);
    if (keep) {
      console.log(`\nprofile/chrome 日志保留在 ${profile}`);
    } else {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
