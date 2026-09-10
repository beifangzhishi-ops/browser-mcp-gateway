[CmdletBinding()]
param([string]$PublicBaseUrl='')

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $repoRoot "config"
$configPath = Join-Path $configDir ".env"
$examplePath = Join-Path $configDir ".env.example"
$stateDir = Join-Path $repoRoot ".state"

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item -LiteralPath $examplePath -Destination $configPath
}

function Set-BmgConfigValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $lines = @($Text -split "\r?\n")
    $found = $false
    $pattern = "^\s*" + [regex]::Escape($Key) + "\s*="
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match $pattern) {
            $lines[$index] = $Key + "=" + $Value
            $found = $true
        }
    }
    if (-not $found) {
        $lines += $Key + "=" + $Value
    }
    return ($lines -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine
}

$configText = Get-Content -LiteralPath $configPath -Raw
$fixedValues = [ordered]@{
    BMG_SIDECAR_HOST = "127.0.0.1"
    BMG_SIDECAR_PORT = "18007"
    BMG_UPSTREAM_URL = "http://127.0.0.1:12306"
    BMG_STATE_FILE = ".state/bmg-oauth-state.json"
    BMG_APPROVAL_SECRET_FILE = ".state/bmg-approval-secret.txt"
    BMG_LOG_DIR = "logs"
    BMG_TOKEN_TTL_SECONDS = "3600"
}
foreach ($key in $fixedValues.Keys) {
    $configText = Set-BmgConfigValue -Text $configText -Key $key -Value $fixedValues[$key]
}
if($PublicBaseUrl){
    try { $baseUri=[Uri]$PublicBaseUrl } catch { throw 'PublicBaseUrl must be an absolute HTTPS origin.' }
    if(-not $baseUri.IsAbsoluteUri -or $baseUri.Scheme -ne 'https' -or $baseUri.AbsolutePath -ne '/' -or $baseUri.UserInfo -or $baseUri.Query -or $baseUri.Fragment){
        throw 'PublicBaseUrl must be a clean HTTPS origin without credentials, path, query, or fragment, for example https://your-machine.your-tailnet.ts.net.'
    }
    $base=$PublicBaseUrl.TrimEnd('/')
    $configText = Set-BmgConfigValue -Text $configText -Key 'BMG_ISSUER' -Value "$base/bmg"
    $configText = Set-BmgConfigValue -Text $configText -Key 'BMG_RESOURCE' -Value "$base/bmg/mcp"
}
if($configText -match 'your-machine\.your-tailnet\.ts\.net'){
    throw 'Set the public hostname in config\.env or rerun with -PublicBaseUrl https://your-machine.your-tailnet.ts.net.'
}
Set-Content -LiteralPath $configPath -Value $configText -Encoding UTF8

$secretFile = Join-Path $repoRoot ".state\bmg-approval-secret.txt"
if (-not (Test-Path -LiteralPath $secretFile)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $secret = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    Set-Content -LiteralPath $secretFile -Value $secret -Encoding ASCII -NoNewline
}

Write-Output "BMG OAuth 已启用。"
Write-Output "配置文件：$configPath"
Write-Output "Approval secret 已保存到独立本地文件：$secretFile"
Write-Output "不会在输出中显示 secret。"
