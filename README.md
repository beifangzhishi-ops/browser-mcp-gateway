# Browser MCP Gateway

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

上游源码保存在忽略目录 `upstream/mcp-chrome/` 中供查阅。运行时使用固定版本的 npm bridge 和发行版扩展；安装脚本对扩展应用网页内容稳定性补丁和 BMG 工作区窗口补丁，补丁源码保存在 `scripts/` 中。

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

Set `BMG_WORKSPACE_MODE=1` in the local ignored `config/.env` to pin page-directed MCP tools to one BMG-owned Edge window/tab. The sidecar creates the workspace window unfocused, persists only its non-sensitive `windowId`/`tabId` plus the exact Win32 `hwnd` under `.state/bmg-workspace.json`, and injects those IDs into upstream tool calls. Navigation stays in that workspace and `chrome_close_tabs` is narrowed to the workspace tab, so normal foreground Edge windows are not selected by default.

工作区使用当前 Edge 用户配置中的 `popup` 弹出窗口，继续共享已有的 Cookie 和登录状态。BMG 只对记录中的专用工作区 HWND 执行屏幕外隐藏和 Win32 工具窗口样式设置，使它不出现在普通任务栏与 Alt-Tab 列表中，同时保持页面渲染。需要手动登录、扫码或验证时，`bmg_show_workspace` 将该窗口显示到前台；`bmg_hide_workspace` 将同一窗口隐藏。普通页面自动化恢复后，BMG 会再次隐藏工作区。显示状态会跨 sidecar 重启保存。

普通窗口与弹出窗口在 Chromium 中使用不同的位置记忆项（[Chromium 源码](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/ui/browser_window_state.cc)）。使用弹出窗口可隔离 BMG 对普通 Edge 窗口位置的影响；实际效果需在本机重载扩展后验证。工作区依然采用屏幕外隐藏，网站弹出窗口与 BMG 弹出窗口仍可能共用弹出窗口位置记忆。历史、书签和窗口列表等全局只读工具不限制在工作区内。

### 修复普通 Edge 新窗口从屏幕边缘出现

旧工作区属于 Edge 普通窗口类型，屏幕外隐藏可能覆盖普通窗口的位置记忆。`setup.ps1` 自动应用窗口类型补丁；已有安装可在项目根目录运行：

```powershell
node scripts\patch-extension-workspace-window.mjs extension
```

保存浏览器中未完成的工作后，按以下顺序完成更新：

1. 运行 `scripts\stop.ps1` 停止 BMG sidecar。
2. 在 `edge://extensions/` 中重新加载 BMG 扩展。
3. 使用 Edge 菜单的“关闭 Microsoft Edge”退出浏览器，确保旧隐藏工作区也已关闭，然后重新打开 Edge。
4. 将普通 Edge 窗口移到希望的位置并调整大小，关闭该窗口后重新打开，恢复位置记忆。
5. 运行 `scripts\start.ps1 -EnsureWorkspace`，创建新弹出工作区。
6. 手动打开、关闭普通 Edge 窗口，确认位置仍按你的操作保存。

更新 sidecar 后，如果扩展尚未重载或旧工作区仍为普通窗口，BMG 会拒绝将其移到屏幕外并保留旧工作区记录。扩展补丁只对带工作区标记的本机引导地址启用弹出类型，普通导航维持原有创建方式。

`BMG_WORKSPACE_IDLE_TIMEOUT_SECONDS` controls automatic workspace cleanup and defaults to `1800` (30 minutes). Any browser tool activity refreshes the idle deadline. When the deadline expires, BMG re-checks the exact tracked workspace window, navigates the tracked tab to `about:blank`, closes only any extra tabs in that same window, and keeps the one blank tab hidden for the next page-directed call. Set the value to `0` to disable idle cleanup. This clears page state without destroying the dedicated Edge workspace and intentionally preserves the shared Edge profile, cookies, and login state.

The upstream project exposes powerful browser capabilities. BMG therefore keeps the upstream listener local and requires the sidecar OAuth layer before forwarding any MCP request.

Treat the public MCP URL as a privileged automation endpoint even though OAuth is required. Keep the upstream listener bound to localhost, protect the public route with the sidecar, and avoid exposing any unprotected browser-control port. The generated OAuth state, approval secret, workspace state, logs, and `config/.env` are local-only and must not be committed.

## Why this repository exists

`mcp-chrome` already provides the mature browser integration: tabs, existing login state, page extraction, interactions, screenshots, network tools, history/bookmarks, and Streamable HTTP MCP. The only local glue needed for this setup is:

- Edge Native Messaging registration on Windows (upstream currently registers Chrome/Chromium only)
- repeatable installation/version pinning
- automatic Windows proxy/PAC handoff for setup
- Tailscale Funnel configuration

That keeps this repository small and makes upstream updates replaceable instead of maintaining another browser automation implementation.


## License

This repository is licensed under the MIT License. Upstream components such as `hangwin/mcp-chrome` retain their own copyright notices and licenses; the pinned upstream project is also MIT-licensed.
