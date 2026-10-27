# 双击关标签

在网页内容区**双击**，直接关掉当前标签页。Chrome / Edge 通用（Manifest V3）。

> 先说清楚一件事：Chrome 扩展**拿不到标签栏（tab strip）上的鼠标事件**。Firefox 有原生的
> `browser.tabs.closeTabByDblclick`，Chrome 一直没有对应的 API，也没有权限去监听浏览器 UI。
> 所以这个扩展做的是一样的事——**双击页面主体区域**关闭标签，这已经是 Chrome 上能做到的最接近的形态。

## 安装

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录
4. 装完**刷新一下已经打开的网页**——内容脚本只会注入到之后加载的页面

## 行为

默认是「智能」模式，只在确定用户不是在干别的事情时才关：

| 你双击的地方 | 结果 |
| --- | --- |
| 普通正文、空白处 | **关闭标签** |
| 输入框、下拉框 | 不关（双击是选词） |
| 链接、按钮、tab、复选框等可交互元素 | 不关（双击有页面自己的语义） |
| 富文本 / 代码编辑器（contenteditable、Monaco、CodeMirror…） | 不关 |
| 双击前已经选中了文字 | 不关 |
| 视频、音频、canvas、iframe | 不关 |
| 按住 Ctrl / Shift / Alt / Cmd 双击 | 不关（视为刻意操作） |
| 窗口里只剩最后一个标签 | 不关，底部弹一条提示 |

想更激进可以在设置页切到「任何位置」模式：只要不在输入控件里，双击哪儿都关。

## 设置

点工具栏图标或扩展详情页的「扩展程序选项」：

- **启用双击关闭**：总开关
- **保留最后一个标签**：默认开，避免把窗口一起关掉
- **触发范围**：智能 / 任何位置
- **站点豁免**：一行一个域名，写主域名即覆盖子域（`example.com` 也管 `docs.example.com`）

设置存在 `chrome.storage.sync`，改动立刻生效，不用刷新页面。

## 实现要点

- `content.js` 只在**捕获阶段**监听 `dblclick`，页面自己的处理器藏不掉这个事件
- 判断逻辑放在内容脚本里，因为只有它能看见 DOM（焦点在哪个输入框、有没有选中文字）
- 真正的关闭动作在 `background.js`，内容脚本不碰 `chrome.tabs`
- 「有选中文字就不关」这一条有个坑：**双击本身就会选中一个词**，浏览器在第二次
  `mousedown` 时已经把选区做好了，到 `dblclick` 阶段再查 `getSelection()` 永远非空。
  所以要在第一次 `mousedown`（`detail === 1`）上取一次快照，拿的是「双击开始前」的状态

## 端到端测试

```powershell
node tools/e2e.mjs
```

真的启动一个 Chrome、真的装扩展、用 CDP 派发真实鼠标事件，然后检查标签到底关没关。9 条用例覆盖上面
行为表里的每一项。

注意两点，都是踩过的坑：

1. **Chrome 137+ 的正式版直接忽略 `--load-extension`**。stderr 里会明确写
   `--load-extension is not allowed in Google Chrome, ignoring.`，扩展压根不会加载，
   测试会静默地全绿/全红。所以 `tools/e2e.mjs` 改用浏览器级 CDP 命令
   `Extensions.loadUnpacked` 来装载扩展。
2. 测「保留最后一个标签」时必须真的把窗口收到只剩一个——只断开 WebSocket 不会关标签，
   前一个用例的页面还开着，测出来的就不是单标签场景。

图标用 `tools/make_icons.py` 生成（Pillow，超采样后缩放），产物在 `icons/`。

## 目录

```
manifest.json      扩展清单（MV3）
background.js      service worker：判断「最后一个标签」并关闭
content.js         内容脚本：判断这一次双击该不该算，然后通知后台
options.html/js    设置页
popup.html/js      工具栏弹窗：总开关 + 本页豁免
ui.css             设置页与弹窗共用的样式
icons/             图标（tools/make_icons.py 生成）
tools/             图标生成脚本与 e2e 测试
```
