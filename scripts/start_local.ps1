[CmdletBinding()]
param([switch]$Lan, [switch]$LocalOnly, [string]$LanAddress = '', [ValidateRange(0, 65535)][int]$Port = 0)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local_runtime.ps1')
$projectDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtimeDirectory = Join-Path $projectDirectory '.runtime'
$serverPath = Join-Path $projectDirectory 'server.mjs'
$configPath = Join-Path $runtimeDirectory 'startup-config.json'
$manifestPath = Join-Path $runtimeDirectory 'server-process.json'
$mutex = $null
$locked = $false

function Get-Listeners {
    return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}
function Test-Application {
    try {
        $health = Invoke-RestMethod -Uri ($baseUrl + '/api/health') -TimeoutSec 2
        if ($health.mode -ne 'local') { return $false }
        $page = Invoke-WebRequest -Uri ($baseUrl + '/admin') -UseBasicParsing -TimeoutSec 2
        return $page.StatusCode -eq 200 -and $page.Content.Contains('<title>股民索赔宝 · 沪紫律师事务所</title>') -and
            $page.Content.Contains('src="/app.js"')
    } catch { return $false }
}
function Test-ListenMode($Listeners) {
    return @($Listeners).Count -gt 0 -and @($Listeners | Where-Object { $_.LocalAddress -ne $listenHost }).Count -eq 0
}
function Save-Ready {
    $configurationDirectory = Join-Path $projectDirectory 'miniprogram'
    if (-not (Test-Path -LiteralPath $configurationDirectory -PathType Container)) { throw '缺少 miniprogram 目录，请保留完整项目。' }
    $configurationPath = Join-Path $configurationDirectory 'network-config.js'
    [IO.File]::WriteAllText($configurationPath, ('module.exports = { apiBase: ''' + $apiBase + ''' };' + [Environment]::NewLine),
        (New-Object System.Text.UTF8Encoding($false)))
    Write-LocalJson $configPath ([ordered]@{ version = 1; mode = $mode; port = $Port; lanAddress = $preferredAddress })
    Write-Host ('电脑后台已就绪：' + $baseUrl + '/admin') -ForegroundColor Green
    if ($mode -eq 'lan') {
        Write-Host ('手机联调地址：' + $apiBase)
        Write-Host ('手机连接检查：' + $apiBase + '/health')
        Write-Host ('已选择网卡：' + $selectedNetwork.Name + '。请让手机与电脑连接同一路由器，并在微信开发者工具重新编译。')
        Write-Host '若手机仍无法访问，可用“放行真机调试端口.cmd”按提示配置防火墙；后台管理仍仅限电脑本机。'
    } else { Write-Host '当前为仅本机模式。真机联调请使用“启动真机调试.cmd”。' }
    Write-Host '已记住启动模式。服务在后台运行，关闭此窗口不影响使用；Windows 登录启动也会沿用此模式。'
}

try {
    if ($Lan -and $LocalOnly) { throw '-Lan 与 -LocalOnly 不能同时使用。' }
    if ($LocalOnly -and $LanAddress) { throw '仅本机模式不能指定 -LanAddress。' }
    Set-Location -LiteralPath $projectDirectory
    [IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
    $digest = [Security.Cryptography.SHA256]::Create()
    try { $lockKey = ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectDirectory.ToLowerInvariant())))).Replace('-', '') }
    finally { $digest.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\HuziStartup-' + $lockKey))
    try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw '另一个启动器正在工作，请稍后重试。' }
    $saved = $null
    if (Test-Path -LiteralPath $configPath) {
        $saved = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($saved.version -ne 1 -or $saved.mode -notin @('local','lan') -or [int]$saved.port -lt 1 -or [int]$saved.port -gt 65535) {
            throw '保存的启动配置无效，请检查 .runtime/startup-config.json。'
        }
    }
    $mode = if ($LocalOnly) { 'local' } elseif ($Lan -or $LanAddress) { 'lan' } elseif ($saved) { $saved.mode } else { 'local' }
    if (-not $Port) { $Port = if ($saved) { [int]$saved.port } else { 7101 } }
    $preferredAddress = if ($mode -eq 'local') { '' } elseif ($LanAddress) { $LanAddress } elseif (-not $Lan -and $saved) { [string]$saved.lanAddress } else { '' }
    $selectedNetwork = if ($mode -eq 'lan') { Select-LanCandidate @(Get-LanCandidates) $preferredAddress } else { $null }
    $listenHost = if ($mode -eq 'lan') { '0.0.0.0' } else { '127.0.0.1' }
    $baseUrl = 'http://127.0.0.1:' + $Port
    $apiBase = 'http://' + $(if ($selectedNetwork) { $selectedNetwork.Address } else { '127.0.0.1' }) + ':' + $Port + '/api'
    $listeners = @(Get-Listeners)
    if ((Test-ListenMode $listeners) -and (Test-Application)) {
        Save-Ready
        Write-Host '已复用相同监听模式的健康服务。'
        exit 0
    }
    if ($listeners.Count) {
        $manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
        $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
        $processInfo = if ($owners.Count -eq 1) { Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owners[0]) } else { $null }
        if (-not (Test-OwnedServer $manifest $processInfo $serverPath $Port)) {
            throw ('端口 ' + $Port + ' 已被占用，无法核准为此启动器创建的项目进程，未停止任何程序。请先由项目负责人核对并关闭旧服务，再重新启动。')
        }
        $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owners[0])
        if (-not (Test-OwnedServer $manifest $processInfo $serverPath $Port)) { throw '服务进程已改变，已取消切换，请重试。' }
        Stop-Process -Id $processInfo.ProcessId -ErrorAction Stop
        for ($attempt = 0; $attempt -lt 20 -and @(Get-Listeners).Count; $attempt++) { Start-Sleep -Milliseconds 100 }
        if (@(Get-Listeners).Count) { throw '旧服务端口尚未释放，已取消启动，请重试。' }
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
            if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { $nodeExecutable = $candidate; break }
        } catch { }
    }
    if (-not $nodeExecutable) { throw '未找到 Node.js 24 或更高版本。请安装后重新启动。' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'node_modules\write-excel-file\package.json') -PathType Leaf)) {
        throw '项目依赖未安装。请在项目目录运行 npm ci。'
    }
    $runKey = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $standardLog = Join-Path $runtimeDirectory ('server-' + $runKey + '.log')
    $errorLog = Join-Path $runtimeDirectory ('server-' + $runKey + '.error.log')
    $env:DEMO_PORT = [string]$Port
    $env:DEMO_HOST = $listenHost
    $env:DEMO_DB = Join-Path $runtimeDirectory 'demo.sqlite'
    $env:DEMO_STARTUP_ID = [guid]::NewGuid().ToString('N')
    $env:LOCAL_TEST_ACCOUNTS = '1'
    $env:LOCAL_PROGRESS_TEST = '1'
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) { $env:REGISTRY_PYTHON = $pythonCommand.Source }
    $serviceProcess = Start-Process -FilePath $nodeExecutable -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $projectDirectory `
        -WindowStyle Hidden -RedirectStandardOutput $standardLog -RedirectStandardError $errorLog -PassThru
    $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $serviceProcess.Id)
    if (-not $processInfo) { throw ('服务未能启动，请查看：' + $errorLog) }
    Write-LocalJson $manifestPath ([ordered]@{ pid = $serviceProcess.Id; port = $Port; host = $listenHost; script = $serverPath;
        executable = $processInfo.ExecutablePath; startedAt = $processInfo.CreationDate.ToUniversalTime().ToString('o'); startupId = $env:DEMO_STARTUP_ID })
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ((Test-ListenMode @(Get-Listeners)) -and (Test-Application)) {
            Save-Ready
            Write-Host ('启动日志：' + $standardLog)
            exit 0
        }
        $serviceProcess.Refresh()
        if ($serviceProcess.HasExited) { break }
        Start-Sleep -Milliseconds 300
    }
    throw ('服务未通过启动检查，请查看错误日志：' + $errorLog)
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($locked -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
