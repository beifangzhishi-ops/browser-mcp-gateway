# AGENT.md

## Repository rules

- Treat `scripts/patch-extension-*.mjs` as the maintained source for BMG changes to the upstream Edge extension. `extension/` is a generated, ignored runtime artifact and must not be committed.
- Rebuild the extension through `scripts/setup.ps1`; it verifies the pinned upstream archive SHA256 before applying BMG patches.
- Keep navigation behavior in `scripts/patch-extension-navigation.mjs`, content fallbacks in `scripts/patch-extension-web-content.mjs` / `scripts/patch-extension-content-cdp.mjs`, and do not duplicate responsibilities across patchers.
- Keep upstream public-tool targeting and record/replay workspace isolation in `scripts/patch-extension-upstream-tools.mjs`. BMG should expose the complete public tool catalog of the pinned `chrome-mcp-shared` version plus dynamic `flow.<slug>` tools; do not maintain duplicate upstream tool schemas in the sidecar.
- Upstream tools that use active/currentWindow semantics must be converted to explicit BMG tab/window targeting before they are reachable through the public BMG endpoint. Dynamic flow tab/window creation, switching, lookup, and closing must stay inside the ownership-verified BMG workspace window.
- Browser automation from local external consumers must go through `bmgctl`; do not read the approval secret or call private `/internal/*` endpoints directly.
- Treat any change to MCP `tools/list`, public tool names, tool descriptions, or input schemas as a ChatGPT plugin/app rebuild event. Restarting the BMG sidecar alone is not sufficient because ChatGPT may retain the previously built tool schema.
- When a rebuild is required, give the user a local PowerShell block that prints the two values needed for the ChatGPT plugin/app rebuild: the public MCP URL from `BMG_RESOURCE` and the OAuth approval key stored at `BMG_APPROVAL_SECRET_FILE`. Prefer the README's absolute-path, direct-current-session form: do not wrap a block containing `$variables` inside an outer double-quoted `powershell.exe -Command "..."`, because the caller shell can expand those variables before the inner PowerShell receives them. This BMG OAuth flow uses dynamic client registration + PKCE with no static client secret; in this workflow, "OAuth key" means the approval secret entered on the BMG consent page.
- Never execute that secret-printing command on the user's behalf, capture its output, read the approval-secret file, or paste the secret into chat. The user must run it locally and use the values themselves during rebuild/reconnection.
- Preserve BMG workspace ownership checks. Never hide, show, move, close, or repurpose an Edge window unless its HWND/marker/process ownership has been verified.
- Workspace recovery must not be suppressed merely because unrelated Edge processes already exist. Recovery may launch a new nonce-marked bootstrap window, but it must not alter unverified Edge windows.
- While a bootstrap claim is still inside the 30-second startup grace window, recovery must reuse that pending claim instead of overwriting its state or launching another bootstrap window.
- Page automation is background-first. Only an explicit foreground request may show the BMG workspace.
- Idle cleanup may only affect tabs in the ownership-verified BMG workspace window; ordinary Edge windows are out of scope.
- Use `node.exe --test tests\sidecar.test.mjs` for the trusted full Node test run under CCM. Also run `git diff --check` before committing.
- Keep `README.md` synchronized with the current implementation and real validation status. Remove obsolete names and descriptions instead of retaining defensive legacy wording.
- When the repository has a remote, finish completed implementation work by committing and pushing the intended branch.
