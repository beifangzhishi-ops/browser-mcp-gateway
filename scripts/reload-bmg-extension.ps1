param(
    [ValidateSet('Verify', 'Reload')]
    [string]$Action = 'Verify'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$ctl = Join-Path $PSScriptRoot 'bmgctl.mjs'
$stateFile = Join-Path $root '.state/bmg-workspace.json'
$extensionId = 'hbdgbgagpkpjffpklnamcljpakneikee'
$optionsUrl = "chrome-extension://$extensionId/options.html"
$ownerState = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if ($ownerState.version -ne 2 -or $ownerState.visible -ne $false -or
    -not $ownerState.windowMarker -or -not $ownerState.tabId) {
    throw 'BMG owner state is not a verified hidden v2 workspace.'
}
if ($Action -eq 'Reload') {
    $staged = Join-Path $root '.cache/extension-staged/background.js'
    $installed = Join-Path $root 'extension/background.js'
    if (-not (Test-Path -LiteralPath $staged) -or
        (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash) {
        throw 'The live extension does not match the staged build; verify and deploy the staged background.js first.'
    }
}

function Invoke-Bmg([string]$name, [object]$arguments = @{}) {
    $json = ConvertTo-Json -InputObject $arguments -Depth 15 -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $reply = & $node $ctl call $name --args-base64 $encoded
    if ($LASTEXITCODE -ne 0) { throw "BMG $name transport failed." }
    $outer = $reply | ConvertFrom-Json -ErrorAction Stop
    if ($outer.success -ne $true -or $outer.result.isError -eq $true) {
        throw "BMG $name failed."
    }
    if ($name -eq 'bmg_workspace_status') { return $outer.result }
    $item = @($outer.result.content | Where-Object { $_.type -eq 'text' }) | Select-Object -First 1
    if (-not $item) { throw "BMG $name omitted its tool result." }
    $value = $item.text | ConvertFrom-Json -ErrorAction Stop
    if ($value.data -and $value.data.content) {
        $nested = @($value.data.content | Where-Object { $_.type -eq 'text' }) | Select-Object -First 1
        if ($nested) { $value = $nested.text | ConvertFrom-Json -ErrorAction Stop }
    }
    if ($value.success -eq $false) { throw "BMG $name returned a browser failure." }
    return $value
}

function Assert-HiddenWorkspace() {
    $status = Invoke-Bmg 'bmg_workspace_status' @{}
    if ($status.available -ne $true -or $status.visibility -ne 'hidden') {
        throw 'Owned BMG workspace is not in verified hidden state.'
    }
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($state.windowId -ne $ownerState.windowId -or $state.tabId -ne $ownerState.tabId -or
        $state.windowMarker -ne $ownerState.windowMarker -or $state.visible -ne $false) {
        throw 'Owned BMG workspace identity or visibility has changed.'
    }
}

function Get-OwnedTab() {
    $listing = Invoke-Bmg 'get_windows_and_tabs' @{}
    $window = @($listing.windows | Where-Object { $_.windowId -eq $ownerState.windowId }) | Select-Object -First 1
    if (-not $window) { throw 'BMG-owned browser window was not found.' }
    $tab = @($window.tabs | Where-Object { $_.tabId -eq $ownerState.tabId }) | Select-Object -First 1
    if (-not $tab -or @($window.tabs).Count -ne 1) {
        throw 'BMG owned anchor tab is missing or extra tabs are present.'
    }
    return $tab
}

function Invoke-JavaScript([string]$code) {
    $payload = Invoke-Bmg 'chrome_javascript' @{
        code = $code; background = $true; timeoutMs = 12000; maxOutputBytes = 1500
    }
    if ($payload.success -ne $true -or $payload.engine -ne 'cdp') {
        throw 'The owned extension page did not execute through CDP.'
    }
    return ($payload.result | ConvertFrom-Json -ErrorAction Stop)
}

$probeCode = @'
if(location.protocol!=="chrome-extension:"||chrome?.runtime?.id!==location.host)
    return {context:false};
const witness=await chrome.runtime.sendMessage({type:"bmg-read-page-runtime-probe-v1"});
const response=await fetch(chrome.runtime.getURL("background.js"),{cache:"no-store"});
if(!response.ok)return {context:true,fetchOk:false};
const source=await response.text();
const start=source.indexOf("  class ReadPageTool extends BaseBrowserToolExecutor {");
const end=source.indexOf("  const readPageTool = new ReadPageTool();",start);
if(start<0||end<=start)return {context:true,fetchOk:true,sourceValid:false};
const bytes=new TextEncoder().encode(source.slice(start,end));
const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)))
    .map(x=>x.toString(16).padStart(2,"0")).join("");
return {
    context:true,fetchOk:true,sourceValid:true,
    sourceHasProbe:source.includes("BMG_READ_PAGE_RUNTIME_PROBE_V1"),
    workerInstancePresent:typeof witness?.workerInstance==="string",
    workerInstance:witness?.workerInstance||null,
    runtimeMatchesSource:digest===witness?.readPageFingerprint
};
'@

$reloadCode = @'
if(location.protocol!=="chrome-extension:"||chrome?.runtime?.id!==location.host||
    typeof chrome.runtime.reload!=="function")return {scheduled:false};
setTimeout(()=>chrome.runtime.reload(),650);
return {scheduled:true};
'@

$enteredOptions = $false
$completed = $false
try {
    Assert-HiddenWorkspace
    $anchor = Get-OwnedTab
    if ($anchor.url -ne 'about:blank' -and $anchor.url -ne $optionsUrl) {
        throw 'Refusing to replace a nonblank browser tab during extension maintenance.'
    }
    if ($anchor.url -ne $optionsUrl) {
        $nav = Invoke-Bmg 'chrome_navigate' @{ url = $optionsUrl; background = $true; newWindow = $false }
        if ($nav.success -ne $true) { throw 'Extension options navigation was rejected.' }
    }
    $enteredOptions = $true
    if ((Get-OwnedTab).url -ne $optionsUrl) { throw 'Owned tab did not reach the target extension.' }
    $previousWorkerInstance = $null
    if ($Action -eq 'Reload') {
        $before = Invoke-JavaScript $probeCode
        if ($before.runtimeMatchesSource -ne $true -or
            -not $before.workerInstance) {
            throw 'Existing worker identity cannot be verified before reload.'
        }
        $previousWorkerInstance = $before.workerInstance
        $check = Invoke-JavaScript 'return {allow:location.protocol==="chrome-extension:"&&chrome?.runtime?.id===location.host&&typeof chrome.runtime.reload==="function"};'
        if ($check.allow -ne $true) { throw 'Target extension reload API is unavailable.' }
        $request = Invoke-JavaScript $reloadCode
        if ($request.scheduled -ne $true) { throw 'Targeted reload was not scheduled.' }
        Write-Output 'targeted_reload_scheduled=true'
        $up = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 2
            $client = New-Object System.Net.Sockets.TcpClient
            try {
                $task = $client.ConnectAsync('127.0.0.1', 12306)
                if ($task.Wait(1800) -and $client.Connected) { $up = $true; break }
            } catch {} finally { $client.Dispose() }
        }
        if (-not $up) { throw '12306 did not recover after the extension reload.' }
        Write-Output 'upstream_listener_recovered=true'
        $nav = Invoke-Bmg 'chrome_navigate' @{ url = $optionsUrl; background = $true; newWindow = $false }
        if ($nav.success -ne $true) { throw 'Could not reopen extension options after reload.' }
    }
    $verified = Invoke-JavaScript $probeCode
    if ($verified.context -ne $true -or $verified.fetchOk -ne $true -or
        $verified.sourceValid -ne $true -or $verified.sourceHasProbe -ne $true -or
        $verified.workerInstancePresent -ne $true -or $verified.runtimeMatchesSource -ne $true) {
        throw 'Running service-worker fingerprint did not match the installed extension source.'
    }
    if ($Action -eq 'Reload' -and $verified.workerInstance -eq $previousWorkerInstance) {
        throw 'Reload was requested but the service-worker instance did not change.'
    }
    Write-Output 'running_read_page_fingerprint_matches_source=true'
    if ($Action -eq 'Reload') { Write-Output 'new_service_worker_instance_verified=true' }
    $completed = $true
} finally {
    if ($enteredOptions) {
        try {
            Assert-HiddenWorkspace
            if ((Get-OwnedTab).url -eq $optionsUrl) {
                $null = Invoke-Bmg 'chrome_navigate' @{ url = 'about:blank'; background = $true; newWindow = $false }
                Write-Output 'owned_anchor_restored_to_blank=true'
            }
        } catch {
            Write-Warning 'Could not verify/restore the owned anchor; inspect before further maintenance.'
            $completed = $false
        }
    }
}
if (-not $completed) { throw 'BMG extension maintenance did not complete safely.' }
