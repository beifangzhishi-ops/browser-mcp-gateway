[CmdletBinding()]
param(
    [Alias("Proxy")]
    [string]$NpmProxy = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cacheDir = Join-Path $repoRoot ".cache"
$extensionDir = Join-Path $repoRoot "extension"
$extensionZip = Join-Path $cacheDir "chrome-mcp-server-1.0.0.zip"

$upstreamRepo = "hangwin/mcp-chrome"
$upstreamCommit = "f48e71751e00bc09725c7e173423cff4f2ccd12a"
$bridgeVersion = "1.0.29"
$extensionTag = "v1.0.0"
$extensionAsset = "chrome-mcp-server-1.0.0.zip"
$extensionSha256 = "e0f7edfe84b64fd452deec048fc202cfa33585943da63a06c08e2bbc97770f6a"

function Require-Command([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        throw "Required command '$Name' was not found in PATH."
    }
    return $command
}

function Get-NpmProxy {
    if (-not [string]::IsNullOrWhiteSpace($NpmProxy)) {
        return $NpmProxy.Trim()
    }

    foreach ($name in @("BROWSER_MCP_NPM_PROXY", "BROWSER_MCP_PROXY")) {
        $value = [Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value.Trim()
        }
    }

    foreach ($name in @("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")) {
        $value = [Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value.Trim()
        }
    }

    try {
        $targetUri = [Uri]"https://registry.npmjs.org/"
        $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
        if ($null -ne $systemProxy) {
            $proxyUri = $systemProxy.GetProxy($targetUri)
            if ($null -ne $proxyUri -and $proxyUri.AbsoluteUri -ne $targetUri.AbsoluteUri) {
                return $proxyUri.AbsoluteUri
            }
        }
    }
    catch {
        Write-Warning "Could not resolve the Windows system proxy for npm: $($_.Exception.Message)"
    }

    return ""
}

function Set-NpmProxyEnvironment([string]$ProxyUri) {
    if ([string]::IsNullOrWhiteSpace($ProxyUri)) {
        return
    }

    foreach ($name in @(
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "NPM_CONFIG_PROXY",
        "NPM_CONFIG_HTTPS_PROXY"
    )) {
        [Environment]::SetEnvironmentVariable($name, $ProxyUri, "Process")
    }
}

Write-Output "Checking prerequisites..."
$gh = Require-Command "gh.exe"
$node = Require-Command "node.exe"
$npm = Require-Command "npm.cmd"

$nodeVersionText = (& $node.Source --version).Trim()
$nodeVersion = [version](($nodeVersionText.TrimStart('v') -split '-')[0])
if ($nodeVersion.Major -lt 20) {
    throw "Node.js 20+ is required. Current version: $nodeVersionText"
}
Write-Output "Node.js: $nodeVersionText"

Write-Output "Checking GitHub CLI authentication..."
& $gh.Source auth status
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not authenticated. Run 'gh auth login' first."
}

Write-Output "Installing mcp-chrome-bridge@$bridgeVersion globally..."
$npmProxy = Get-NpmProxy
if (-not [string]::IsNullOrWhiteSpace($npmProxy)) {
    Set-NpmProxyEnvironment $npmProxy
    try {
        $proxyUri = [Uri]$npmProxy
        Write-Output "npm proxy: $($proxyUri.Scheme)://$($proxyUri.Host):$($proxyUri.Port)"
    }
    catch {
        Write-Output "npm proxy: configured"
    }
}
else {
    Write-Output "npm proxy: direct"
}

& $npm.Source install -g "mcp-chrome-bridge@$bridgeVersion"
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed. GitHub traffic uses gh, but npm still needs access to registry.npmjs.org."
}

Write-Output "Registering mcp-chrome Native Messaging directly for Microsoft Edge..."
& (Join-Path $PSScriptRoot "register-edge.ps1")

New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
$downloadRequired = $true
if (Test-Path -LiteralPath $extensionZip) {
    $existingHash = (Get-FileHash -LiteralPath $extensionZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $downloadRequired = $existingHash -ne $extensionSha256
}

if ($downloadRequired) {
    Write-Output "Downloading upstream extension $extensionTag with gh..."
    Remove-Item -LiteralPath $extensionZip -Force -ErrorAction SilentlyContinue
    & $gh.Source release download $extensionTag --repo $upstreamRepo --pattern $extensionAsset --dir $cacheDir --clobber
    if ($LASTEXITCODE -ne 0) {
        throw "gh release download failed."
    }
}

if (-not (Test-Path -LiteralPath $extensionZip)) {
    throw "Expected extension archive was not downloaded: $extensionZip"
}

$actualHash = (Get-FileHash -LiteralPath $extensionZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $extensionSha256) {
    Remove-Item -LiteralPath $extensionZip -Force -ErrorAction SilentlyContinue
    throw "Extension SHA256 mismatch. Expected $extensionSha256 but got $actualHash"
}
Write-Output "Extension SHA256 verified."

$extractDir = Join-Path $cacheDir "extension-extracted"
if (Test-Path -LiteralPath $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
}
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
Expand-Archive -LiteralPath $extensionZip -DestinationPath $extractDir -Force

$manifest = Get-ChildItem -LiteralPath $extractDir -Filter "manifest.json" -File -Recurse | Select-Object -First 1
if ($null -eq $manifest) {
    throw "Downloaded extension archive does not contain manifest.json"
}

if (Test-Path -LiteralPath $extensionDir) {
    Remove-Item -LiteralPath $extensionDir -Recurse -Force
}
New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null
$manifestDir = Split-Path -Parent $manifest.FullName
Get-ChildItem -LiteralPath $manifestDir -Force | Copy-Item -Destination $extensionDir -Recurse -Force

Write-Output "Applying BMG web-content stability patch..."
& $node.Source (Join-Path $PSScriptRoot "patch-extension-web-content.mjs") $extensionDir
if ($LASTEXITCODE -ne 0) {
    throw "BMG web-content extension patch failed."
}

Write-Output "应用 BMG 工作区窗口位置隔离补丁..."
& $node.Source (Join-Path $PSScriptRoot "patch-extension-workspace-window.mjs") $extensionDir
if ($LASTEXITCODE -ne 0) {
    throw "BMG 工作区窗口补丁失败。"
}

Write-Output ""
Write-Output "Setup complete."
Write-Output "Upstream reference commit: $upstreamCommit"
Write-Output ""
Write-Output "Next steps:"
Write-Output "  1. Open Edge normally."
Write-Output "  2. Go to edge://extensions and enable Developer mode."
Write-Output "  3. Load unpacked: $extensionDir"
Write-Output "  4. Open the extension and connect it."
Write-Output "  5. Run scripts\status.ps1 and confirm port 12306 is listening."
Write-Output "  6. Run scripts\configure-funnel.ps1 from elevated PowerShell."
