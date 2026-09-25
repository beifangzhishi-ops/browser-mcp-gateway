# AGENT.md

## Repository rules

- Treat `scripts/patch-extension-*.mjs` as the maintained source for BMG changes to the upstream Edge extension. `extension/` is a generated, ignored runtime artifact and must not be committed.
- Rebuild the extension through `scripts/setup.ps1`; it verifies the pinned upstream archive SHA256 before applying BMG patches.
- Keep navigation behavior in `scripts/patch-extension-navigation.mjs`, content fallbacks in `scripts/patch-extension-web-content.mjs` / `scripts/patch-extension-content-cdp.mjs`, and do not duplicate responsibilities across patchers.
- Browser automation from local external consumers must go through `bmgctl`; do not read the approval secret or call private `/internal/*` endpoints directly.
- Preserve BMG workspace ownership checks. Never hide, show, move, close, or repurpose an Edge window unless its HWND/marker/process ownership has been verified.
- Page automation is background-first. Only an explicit foreground request may show the BMG workspace.
- Idle cleanup may only affect tabs in the ownership-verified BMG workspace window; ordinary Edge windows are out of scope.
- Use `node.exe --test tests\sidecar.test.mjs` for the trusted full Node test run under CCM. Also run `git diff --check` before committing.
- Keep `README.md` synchronized with the current implementation and real validation status. Remove obsolete names and descriptions instead of retaining defensive legacy wording.
- When the repository has a remote, finish completed implementation work by committing and pushing the intended branch.
