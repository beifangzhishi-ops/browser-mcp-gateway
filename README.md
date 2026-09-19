# Browser MCP Gateway

工作区真正隐藏与登录恢复的后续实施见 [中文实施计划](PLAN.md)，其中包含当前证据、实施顺序、恢复策略及验收标准。

Windows gateway around [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) for using an existing Microsoft Edge session from ChatGPT through an OAuth-protected HTTPS endpoint such as Tailscale Funnel.

This repository wraps the upstream project, adds Microsoft Edge Native Messaging registration on Windows, and exposes it through an independent local OAuth sidecar.

## BMG OAuth sidecar

当前正式并行架构如下：

```text
ChatGPT
    |
    | OAuth + MCP
    v
https://your-machine.your-tailnet.ts.net/bmg/mcp
    |
    v
127.0.0.1:18007  BMG OAuth sidecar
    |
    v
127.0.0.1:12306  upstream mcp-chrome
    |
    v
Edge Native Messaging + extension
```

sidecar 只绑定 127.0.0.1:18007，不修改 upstream mcp-chrome 核心实现，也不拥有 Edge 或 12306 的生命周期。其 issuer 是 https://your-machine.your-tailnet.ts.net/bmg，resource 是 https://your-machine.your-tailnet.ts.net/bmg/mcp。OAuth state、upstream session state、approval secret、日志和 config/.env 均由 BMG 独立保存。access token 默认 1 小时有效；授权码兑换会同时签发 30 天 refresh token，refresh token 每次使用都会轮换，为新会话或 access token 过期后的无人工批准续期提供凭证。

启用并启动 sidecar：

```powershell
.\scripts\enable-oauth.ps1 -PublicBaseUrl https://your-machine.your-tailnet.ts.net
.\scripts\start.ps1
```

安装或更新当前用户登录自启（无需管理员权限）：

```powershell
.\scripts\install-autostart.ps1
```

计划任务 `BMG Sidecar` 在当前用户登录 Windows 时执行 `start.ps1 -EnsureWorkspace`。它先启动或复用 BMG 服务，再检查专用浏览器工作区：已有窗口则复用，窗口缺失则创建隐藏工作区。如果创建失败，脚本会检查当前 Windows 会话的 Edge 进程；Edge 未运行时，使用默认用户配置启动一个空白窗口，然后等待扩展自动连接并再次创建工作区。已有 Edge 时保持其进程和用户配置。

需在 `config/.env` 中设置 `BMG_WORKSPACE_MODE=1`，并在所用 Edge 配置中安装、启用 BMG 扩展及其自动连接。工作区检查失败后依次等待 10、20、40 秒重试；最终失败会让计划任务报错，由任务按每分钟一次、最多三次的设置重试。日志位于 `logs/bmg-workspace-startup.log`。每次任务触发都会重新核对工作区是否存在；任务完成后不持续监控窗口。Windows 重启后需登录当前用户才触发任务。

手动执行同一启动流程：

```powershell
.\scripts\start.ps1 -EnsureWorkspace
```

本机工作区检查接口 `/internal/ensure-workspace` 仅接受匹配本机地址、无浏览器 Origin 且携带本机认证密钥的 POST 请求，使用 sidecar 自身的共享上游会话。密钥从本地文件读取，不出现在启动参数或日志中。更新该功能后，已运行的 sidecar 需重启以加载新接口。

如需移除：

```powershell
.\scripts\uninstall-autostart.ps1
```

停止 sidecar 只校验 BMG PID file、18007 精确 loopback listener 和本地 health，不会停止 12306、Node、Edge 或 Native Messaging：

```powershell
.\scripts\stop.ps1
```

本地端到端检查（需要 upstream 12306 和 Edge extension 已运行）：

```powershell
node scripts\test-bmg-e2e.mjs
```

该检查连续运行两轮 OAuth/PKCE，并验证两轮共享同一个 upstream MCP session。每轮的下游 DELETE 只关闭客户端视角的 session，不会关闭共享 upstream transport；sidecar 停止时关闭自身监听并保留该 session 的非敏感元数据，重启后继续复用。这样兼容 upstream 的 singleton transport 生命周期。

文件传输：在 workspace 模式下，BMG 会补充暴露 upstream 已实现但默认 tools/list 未列出的 chrome_upload_file 和 chrome_handle_download。上传应优先使用 chrome_upload_file 直接通过 CDP DOM.setFileInputFiles 设置 <input type=file>，避免点击控件后弹出 Windows 文件选择器；chrome_handle_download 用于等待浏览器管理的下载并返回最终本机文件路径、状态和大小。Windows 原生 File System Access / Save As 对话框不属于这两个工具的控制范围，必要时使用 mg_show_workspace 进行人工处理。

configure-funnel.ps1 和 disable-funnel.ps1 默认只输出预览；本阶段不实际修改 Tailscale Funnel。未来若明确需要应用，才显式使用 -Apply，脚本也只处理 BMG 自己的精确 OAuth/MCP 路径。

## Architecture

```text
ChatGPT Web
    |
    | OAuth + HTTPS / MCP
    v
Tailscale Funnel
    |
    v
https://your-machine.your-tailnet.ts.net/bmg/mcp
    |
    v
127.0.0.1:18007  BMG OAuth sidecar
    |
    | local HTTP proxy
    v
127.0.0.1:12306  upstream mcp-chrome
    |
    | Native Messaging
    v
Edge extension + normal Edge tabs
```

sidecar、upstream、Native Messaging 和 Edge extension 分属独立生命周期。登录启动脚本负责在需要时启动 Edge 并准备工作区；sidecar 通过扩展操作已有浏览器，不创建专用浏览器 profile，也不修改 upstream 核心实现。停止 sidecar 保留 Edge 和工作区窗口。

## Upstream versions currently pinned

- Source: `hangwin/mcp-chrome` commit `f48e71751e00bc09725c7e173423cff4f2ccd12a`
- Native bridge: `mcp-chrome-bridge@1.0.29`
- Extension release: `v1.0.0`
- Extension archive SHA256: `e0f7edfe84b64fd452deec048fc202cfa33585943da63a06c08e2bbc97770f6a`

The source checkout is kept under ignored `upstream/mcp-chrome/` for inspection only. Runtime uses the upstream npm bridge package and release extension rather than a locally modified fork.

## Requirements

- Windows 10/11
- Microsoft Edge
- Git
- Node.js 20+
- npm
- Tailscale with Funnel enabled for this device/tailnet

## Install

If GitHub CLI already works on your machine, the easiest clone command is:

```powershell
gh repo clone beifangzhishi-ops/browser-mcp-gateway
cd browser-mcp-gateway
```

Plain Git also works when Git itself has network access:

```powershell
git clone https://github.com/beifangzhishi-ops/browser-mcp-gateway.git
cd browser-mcp-gateway
```

Then run:

```powershell
.\scripts\setup.ps1
```

or double-click:

```text
安装.cmd
```

Setup will:

1. Verify GitHub CLI authentication and resolve the configured npm proxy.
2. Install `mcp-chrome-bridge@1.0.29` globally with npm.
3. Register the installed Native Messaging host directly for Microsoft Edge.
4. Download and SHA256-verify the pinned upstream extension release into `extension/`.

It does not register or configure Google Chrome.

## Windows 命令说明

仓库脚本在 Windows 上显式调用 `gh.exe`、`node.exe`、`npm.cmd` 和 `mcp-chrome-bridge.cmd`，避免 PowerShell 执行策略拦截 npm 生成的 `.ps1` shim；当 PATH 中存在多个同名程序时取第一个匹配项，`状态.cmd` 会直接显示这些程序的版本。当前仓库固定的 `mcp-chrome-bridge@1.0.29` 提供 `register`、`fix-permissions` 和 `update-port`，不包含 `doctor` 子命令；排查时不要直接运行 `mcp-chrome-bridge.ps1`。新版桥接包可能引入需要本机编译的原生依赖，升级前应先确认 Node.js 版本兼容性。

### Proxy handling

`setup.ps1` automatically tries to make command-line downloads follow the same Windows proxy/PAC route used by desktop applications.

Proxy priority is:

1. `-Proxy` parameter
2. `BROWSER_MCP_PROXY` environment variable
3. existing `HTTPS_PROXY` / `HTTP_PROXY` environment variables
4. Windows system proxy/PAC resolved separately for GitHub and npm

The resolved proxy is injected only into the setup process for Git, npm, and the extension download. It is not written into your global Git or npm configuration.

CI checks the Windows target-specific proxy lookup and npm handoff behavior directly, rather than requiring a particular helper function name.

Examples:

```powershell
.\scripts\setup.ps1 -Proxy http://127.0.0.1:7890
```

or:

```powershell
$env:BROWSER_MCP_PROXY = "http://127.0.0.1:7890"
.\安装.cmd
```

When auto-detection works, setup prints a line such as:

```text
Network route for https://github.com/ : http://127.0.0.1:7890 [Windows system proxy/PAC]
```

## Load the extension in Edge

1. Open Edge normally from the desktop/taskbar.
2. Visit `edge://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository's `extension` directory.
6. Open the extension and connect it to the native bridge.

The upstream Native Messaging host name is `com.chromemcp.nativehost`. The default extension ID expected by upstream is `hbdgbgagpkpjffpklnamcljpakneikee`.

If Edge shows a different unpacked extension ID, rerun:

```powershell
.\scripts\register-edge.ps1 -ExtensionId YOUR_EDGE_EXTENSION_ID
```

After the extension connects, the upstream MCP endpoint should be:

```text
http://127.0.0.1:12306/mcp
```

## Tailscale Funnel

After the Edge extension is connected, local port 12306 is listening, and the sidecar health is 200, use an elevated PowerShell only when a Funnel change is explicitly approved:

```powershell
.\scripts\configure-funnel.ps1
.\scripts\configure-funnel.ps1 -Apply
```

The first command is preview-only. The second command applies only the BMG route list. The ChatGPT custom MCP server URL is https://your-machine.your-tailnet.ts.net/bmg/mcp.


## Status

```powershell
.\scripts\status.ps1
```

This checks Node/npm, the installed bridge, Edge Native Messaging registration, local MCP port 12306, and Tailscale Funnel status.

## Important security note

## GPT dedicated browser workspace

在本机被忽略的 `config/.env` 中设置 `BMG_WORKSPACE_MODE=1` 后，页面定向 MCP 工具会固定到一个 BMG 专属 Edge 窗口／标签页。该窗口仍使用用户现有 Edge 配置，因此继续共享 Cookie、登录态和扩展。sidecar 会把 `windowId`、`tabId`、Win32 `hwnd`、随机 ownership marker、Edge PID／进程启动时间和显隐状态写入 `.state/bmg-workspace.json`。导航始终复用该工作区，`chrome_close_tabs` 也会被收窄到工作区标签页，避免默认选中普通前台 Edge 窗口。

正式隐藏方式现在是 Windows `ShowWindowAsync(SW_HIDE)`，不再把窗口移动到 `(-32000,-32000)`。首次认领时，BMG 会给目标 HWND 设置进程内 Win32 属性 marker；后续隐藏、显示和 sidecar 重启恢复都必须同时验证 HWND、marker 和 `msedge` 进程身份，已有进程指纹时还会核对 PID／启动时间。无法证明归属时只退休本地记录，不关闭或修改那个可能已经属于用户的窗口。隐藏操作使用 `SWP_NOMOVE|SWP_NOSIZE`，并验证隐藏前后窗口几何不变；显示操作同样不强制居中或改尺寸，只有显式调用 `bmg_show_workspace` 时才尝试前台激活。页面自动化恢复后，BMG 会再次把同一个 ownership-verified 工作区真正隐藏。

新工作区创建不再传固定的 480×360 尺寸。受 Git 管理的 `scripts/patch-extension-web-content.mjs` 还会补丁上游 `chrome_navigate`：调用方未指定宽高时，`chrome.windows.create` 不再自动补入上游默认的 1280×720；同时对 `127.0.0.1`、IPv6 和 `localhost` 不再生成非法的 `www.` URL pattern，避免本地 bootstrap URL 在创建窗口前被上游导航逻辑拒绝。这样 BMG 不再通过固定小窗口或屏幕外坐标持续覆盖共享 Edge 的普通窗口几何。旧的 v1 工作区状态没有可验证 marker，会被安全退休；不会凭旧 HWND 去移动、显示或关闭旧窗口。因此其他机器若仍保留由 v1 对应的旧窗口，该窗口可能继续存在到用户关闭它或 Edge 重启，BMG 不会为了去重而猜测归属后强行清理。

登录准备时，`scripts/ensure-edge.ps1` 只在当前交互会话没有 Edge 时启动浏览器。新启动窗口使用一次性 `/workspace-bootstrap?nonce=...` URL，并把 nonce 与 ownership marker 写到 `.state/bmg-edge-bootstrap.json`；脚本会立即尝试用同一个真正隐藏 helper 认领并 `SW_HIDE` 该窗口。sidecar 随后只认领 URL 中 nonce 完全匹配的窗口，不再额外创建第二个空白窗口。若扩展尚未连接，启动流程保持有限重试，不把“存在 Edge 进程”当成“工作区已经可用”。

普通使用请求也有一次有限恢复路径：首次工作区准备失败后，sidecar 调用同一个 `ensure-edge.ps1`，默认按 1 秒、2.5 秒、5 秒间隔重试工作区准备。该脚本在当前会话已有 Edge 时不会新启动进程，因此这不是持续监控，也不会在用户没有使用请求时反复拉起主动退出的 Edge。若浏览器／扩展仍未就绪，请求最终按错误返回，不无限创建窗口。

`BMG_WORKSPACE_IDLE_TIMEOUT_SECONDS` 控制自动清理，默认 `1800` 秒。浏览器工具活动会刷新期限；到期后 BMG 重新验证 ownership，导航工作区标签页到 `about:blank`，只关闭同一受控窗口中的额外标签页，并保留一个真正隐藏的空白标签页。设置为 `0` 可禁用空闲清理。读历史、书签、窗口列表等全局工具仍不是 window-scoped。

自动化验证目前覆盖：startup nonce 去重认领、按需恢复、v2 ownership 恢复、过期 HWND／marker 安全退休、v1 状态迁移、不改几何的 Win32 helper 静态约束、空闲清理、人工显示后恢复隐藏、截图参数绑定，以及扩展补丁幂等；`npm.cmd test` 当前为 29/29 通过。2026-09-20 已在正式 `@BMG` 链路上完成真实桌面验收：工作区创建成功并返回 `visible=false`／`hidden=true`，精确 HWND 检查确认窗口未最小化、几何仍为自然位置且未出现 `-32000`，同时普通 Edge 窗口保持正常；隐藏状态下 `chrome_get_web_content` 也成功读取 bootstrap 页面。整页／元素截图和实际重启登录验收仍未执行，不能用单元测试替代。

The upstream project exposes powerful browser capabilities. BMG therefore keeps the upstream listener local and requires the sidecar OAuth layer before forwarding any MCP request.

Treat the public MCP URL as a privileged automation endpoint even though OAuth is required. Keep the upstream listener bound to localhost, protect the public route with the sidecar, and avoid exposing any unprotected browser-control port. The generated OAuth state, approval secret, workspace state, logs, and `config/.env` are local-only and must not be committed.

## 真正隐藏窗口的独立验证（2026-09-19）

本机在正式接入前使用独立测试窗口验证了 Windows `ShowWindowAsync(SW_HIDE)`；该次试验本身没有修改当时的正式工作区隐藏方式。试验通过现有上游 MCP 调用 `chrome_screenshot`，明确传入测试 `tabId`、`windowId`、`background: true`、`fullPage: false`，绕开当时 sidecar 的屏幕外维护步骤。当前正式实现已经改用真正隐藏，但下列结果仍作为真实窗口证据保留。

验证结果：

- 窗口从可见变为不可见，保持非最小化状态，边界始终为 `(960, 12, 1920, 732)`。
- 隐藏后仍能正常取得当前视口截图；隐藏期间导航到新页面，内容读取与截图均显示新内容。
- Windows 窗口事件记录中，隐藏期间没有重新显示事件。
- 隐藏状态下新页面的截图与恢复可见后的截图文件完全一致。
- 测试窗口已恢复并关闭。

第二轮使用 `--hidden-only`：创建后隐藏，等待 10 秒再截图，完成后直接关闭测试标签页。两次截图前后均为不可见、坐标保持 `(0, 10, 960, 730)`，记录中只有隐藏事件；阶段二截图和内容读取成功。用户在两轮试验中均观察到短暂闪现，因此尚不能宣称整套流程无闪现。创建测试窗口到隐藏之间存在可见阶段，需与截图阶段分别验证；未把用户观察归因于“小概率并发”。

这证明普通后台截图可与真正隐藏配合。当前代码已调整隐藏／显示脚本以识别真正不可见且 ownership-verified 的 HWND，并用自动化测试覆盖 sidecar 恢复；但整页截图、元素截图、长期真实隐藏、用户同时操作普通 Edge、普通窗口位置记忆和实际重启登录仍未完成真实桌面验收。

重复试验前需连接 BMG 扩展，并明确允许操作新建测试窗口；脚本依赖 Windows、Node.js 和 Python。执行期间会创建一个 960×720 的测试窗口、隐藏并恢复它，最后关闭其唯一测试标签页；不操作已有用户窗口。创建和关闭测试窗口仍可能更新 Edge 的普通窗口大小／位置记忆。

```powershell
node scripts\test-hidden-window.mjs
# 隐藏后直接关闭，不主动恢复窗口
node scripts\test-hidden-window.mjs --hidden-only
```

截图及记录写入 `.state/隐藏窗口试验/`。若上游会话已失效，脚本会重新初始化共享 MCP 会话并保存连接信息；不重启服务，不删除共享会话。Windows 控制器 `scripts/probe-hidden-window.py` 每次操作前检查随机标题标记、进程 ID 和 `msedge.exe` 身份，使用窗口事件监听记录显示／隐藏变化。参考：[Windows 窗口隐藏接口](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindowasync)、[CDP 截图接口](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)。

## Why this repository exists

`mcp-chrome` already provides the mature browser integration: tabs, existing login state, page extraction, interactions, screenshots, network tools, history/bookmarks, and Streamable HTTP MCP. The only local glue needed for this setup is:

- Edge Native Messaging registration on Windows (upstream currently registers Chrome/Chromium only)
- repeatable installation/version pinning
- automatic Windows proxy/PAC handoff for setup
- Tailscale Funnel configuration

That keeps this repository small and makes upstream updates replaceable instead of maintaining another browser automation implementation.


## License

This repository is licensed under the MIT License. Upstream components such as `hangwin/mcp-chrome` retain their own copyright notices and licenses; the pinned upstream project is also MIT-licensed.
