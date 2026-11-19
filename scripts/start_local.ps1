[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectDirectory '.runtime'
$adminUrl = 'http://127.0.0.1:7101/admin'

function Test-LocalApplication {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:7101/api/health' -TimeoutSec 2
        if ($health.mode -ne 'local') { return $false }
        $page = Invoke-WebRequest -Uri $adminUrl -UseBasicParsing -TimeoutSec 2
        return $page.StatusCode -eq 200 -and
            $page.Content.Contains('<title>股民索赔宝 · 沪紫律师事务所</title>') -and
            $page.Content.Contains('src="/app.js"')
    } catch {
        return $false
    }
}

function Test-LocalPort {
    return @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq 7101 }).Count -gt 0
}

function Show-Ready {
    Write-Host '本地后台已就绪。请在浏览器打开或刷新：' -ForegroundColor Green
    Write-Host $adminUrl
    Write-Host '服务在后台运行，关闭此窗口不影响使用。电脑重启后需重新双击启动。'
}

try {
    Set-Location -LiteralPath $projectDirectory
    if (Test-LocalApplication) {
        Write-Host '已复用正在运行的本地服务。'
        Show-Ready
        exit 0
    }
    if (Test-LocalPort) {
        throw '7101 端口已被占用，但未识别为本项目的健康服务。请检查占用程序；启动器不会关闭其他程序。'
    }

    $nodeCandidates = @()
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
    if ($env:ProgramFiles) { $nodeCandidates += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    $nodeExecutable = $null
    foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $version = & $candidate --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) {
                $nodeExecutable = $candidate
                break
            }
        } catch { }
    }
    if (-not $nodeExecutable) { throw '未找到 Node.js 24 或更高版本。请安装后重新启动。' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'node_modules\write-excel-file\package.json') -PathType Leaf)) {
        throw '项目依赖未安装。请在项目目录运行 npm ci，完成后重新双击启动。'
    }

    [System.IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
    $runKey = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $standardLog = Join-Path $runtimeDirectory ('server-' + $runKey + '.log')
    $errorLog = Join-Path $runtimeDirectory ('server-' + $runKey + '.error.log')
    $env:DEMO_PORT = '7101'
    $env:DEMO_DB = Join-Path $runtimeDirectory 'demo.sqlite'
    $env:LOCAL_TEST_ACCOUNTS = '1'
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) { $env:REGISTRY_PYTHON = $pythonCommand.Source }
    $serviceProcess = Start-Process -FilePath $nodeExecutable -ArgumentList 'server.mjs' -WorkingDirectory $projectDirectory `
        -WindowStyle Hidden -RedirectStandardOutput $standardLog -RedirectStandardError $errorLog -PassThru

    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        if (Test-LocalApplication) {
            Show-Ready
            Write-Host ('启动日志：' + $standardLog)
            exit 0
        }
        $serviceProcess.Refresh()
        if ($serviceProcess.HasExited) { break }
        Start-Sleep -Milliseconds 400
    }
    throw ('服务未能通过启动检查。请查看错误日志：' + $errorLog)
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
