[CmdletBinding()]
param([switch]$Disable)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot 'start_local.ps1'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory '沪紫律所本地后台.lnk'
$description = '沪紫律所本地后台：登录当前 Windows 账户后自动启动'

try {
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw '未找到本地启动脚本。请保留完整项目目录。'
    }
    [System.IO.Directory]::CreateDirectory($startupDirectory) | Out-Null
    $shortcutShell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $shortcutPath) {
        $existingShortcut = $shortcutShell.CreateShortcut($shortcutPath)
        if ($existingShortcut.Description -ne $description) {
            throw '同名启动项不是本项目创建的，未覆盖或删除。'
        }
    }
    if ($Disable) {
        if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
        Write-Host '已关闭当前 Windows 账户的登录自动启动；正在运行的服务不受影响。'
        exit 0
    }
    $powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellPath
    $shortcut.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '"'
    $shortcut.WorkingDirectory = $projectDirectory
    $shortcut.WindowStyle = 7
    $shortcut.Description = $description
    $shortcut.Save()
    Write-Host '已设置：登录当前 Windows 账户后，在后台自动启动本地服务。'
    Write-Host '不会自动打开浏览器。登录后稍等片刻，再访问 http://127.0.0.1:7101/admin 。'
    Write-Host '项目移动后请重新运行本脚本；使用 -Disable 可关闭自动启动。'
} catch {
    Write-Host ('设置失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
