[CmdletBinding()]
param(
    [string]$ExtensionId = "hbdgbgagpkpjffpklnamcljpakneikee"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
    throw "ExtensionId cannot be empty."
}

$npm = Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
$globalRoot = (& $npm.Source root -g | Select-Object -Last 1).Trim()
if ([string]::IsNullOrWhiteSpace($globalRoot)) {
    throw "Could not determine npm global root."
}

$hostName = "com.chromemcp.nativehost"
$wrapperPath = Join-Path $globalRoot "mcp-chrome-bridge\dist\run_host.bat"
if (-not (Test-Path -LiteralPath $wrapperPath)) {
    throw "mcp-chrome-bridge native host wrapper was not found at: $wrapperPath"
}

$edgeManifestDir = Join-Path $env:APPDATA "Microsoft\Edge\NativeMessagingHosts"
$edgeManifest = Join-Path $edgeManifestDir "$hostName.json"
$edgeRegistryKey = "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"

New-Item -ItemType Directory -Path $edgeManifestDir -Force | Out-Null

$manifest = [ordered]@{
    name = $hostName
    description = "Node.js Host for Browser Bridge Extension"
    path = $wrapperPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}

$json = $manifest | ConvertTo-Json -Depth 10
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($edgeManifest, $json, $utf8NoBom)

& reg.exe add $edgeRegistryKey /ve /t REG_SZ /d $edgeManifest /f | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to register the Edge Native Messaging host."
}

Write-Output "Edge Native Messaging host registered."
Write-Output "Native host:   $wrapperPath"
Write-Output "Manifest:      $edgeManifest"
Write-Output "Registry key:  $edgeRegistryKey"
Write-Output "Extension ID:  $ExtensionId"
