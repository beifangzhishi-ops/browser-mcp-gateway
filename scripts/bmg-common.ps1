$script:BmgRepoRoot = Split-Path -Parent $PSScriptRoot
$script:BmgForbiddenPorts = @(8317, 8765, 8766, 8767, 12306)

function Get-BmgConfigValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Key
    )

    $configPath = Join-Path $script:BmgRepoRoot "config\.env"
    if (-not (Test-Path -LiteralPath $configPath)) {
        return ""
    }
    foreach ($line in (Get-Content -LiteralPath $configPath)) {
        if ($line -match ("^\s*" + [regex]::Escape($Key) + "\s*=\s*(.*?)\s*$")) {
            $value = $matches[1].Trim()
            if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
                return $value.Substring(1, $value.Length - 2)
            }
            if ($value.Length -ge 2 -and $value.StartsWith("'") -and $value.EndsWith("'")) {
                return $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return ""
}

function Get-BmgPort {
    $rawPort = Get-BmgConfigValue -Key "BMG_SIDECAR_PORT"
    if ([string]::IsNullOrWhiteSpace($rawPort)) {
        $rawPort = "18007"
    }
    if ($rawPort -notmatch "^\d+$") {
        throw "BMG_SIDECAR_PORT must be numeric."
    }
    $port = [int]$rawPort
    if ($port -lt 1 -or $port -gt 65535) {
        throw "BMG_SIDECAR_PORT must be between 1 and 65535."
    }
    if ($script:BmgForbiddenPorts -contains $port) {
        throw "BMG_SIDECAR_PORT is reserved: $port"
    }
    return $port
}

function Get-BmgLoopbackListenerPid {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    try {
        $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Where-Object { $_.LocalAddress -in @("127.0.0.1", "::1") } |
            Select-Object -First 1
        if ($null -ne $connection) {
            return [int]$connection.OwningProcess
        }
    }
    catch {}

    $netstatPath = Join-Path $env:SystemRoot "System32\netstat.exe"
    if (-not (Test-Path -LiteralPath $netstatPath)) {
        $netstatCommand = Get-Command netstat.exe -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -eq $netstatCommand) {
            return $null
        }
        $netstatPath = $netstatCommand.Source
    }
    foreach ($line in (& $netstatPath -ano -p TCP 2>$null)) {
        if ($line -notmatch "^\s*TCP\s+(\S+):([0-9]+)\s+\S+\s+LISTENING\s+([0-9]+)\s*$") {
            continue
        }
        $address = $matches[1] -replace "^\[|\]$", ""
        if ([int]$matches[2] -eq $Port -and $address -in @("127.0.0.1", "::1")) {
            return [int]$matches[3]
        }
    }
    return $null
}

function Get-BmgHealth {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $healthUrl = "http://127.0.0.1:$Port/health"
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 4 -ErrorAction Stop
        if ([int]$response.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace([string]$response.Content)) {
            return $null
        }
        $health = [string]$response.Content | ConvertFrom-Json
        if (
            $health.status -ne "ok" -or
            $health.service -ne "bmg-sidecar" -or
            [int]$health.port -ne $Port
        ) {
            return $null
        }
        return $health
    }
    catch {
        return $null
    }
}

function Get-BmgProcess {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    return Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ProcessId) -ErrorAction SilentlyContinue
}

function Test-BmgProcessCommandLine {
    param(
        [Parameter(Mandatory = $false)]
        $Process
    )

    if ($null -eq $Process -or [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)) {
        return $true
    }
    return [string]$Process.CommandLine -match "sidecar[\\/]+server\.mjs"
}
