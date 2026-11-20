[CmdletBinding()]
param([switch]$Remove, [switch]$CheckOnly, [ValidateRange(1024,65535)][int]$Port = 7101)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$ruleName = 'Huzilvsuo-MiniProgram-LAN-' + $Port

try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $CheckOnly -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '需要 Windows 管理员权限。请右键项目中的“放行真机调试端口.cmd”，选择“以管理员身份运行”。此脚本只处理本项目端口的局域网规则，不关闭防火墙。'
    }
    if ($Remove) {
        $existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
        if ($existing) {
            if ($existing.Group -ne 'Huzilvsuo Local Development') { throw '同名防火墙规则不属于本工具，未删除。' }
            if ($CheckOnly) { Write-Host ('将删除规则：' + $ruleName) }
            else { Remove-NetFirewallRule -Name $ruleName; Write-Host '已删除本项目的局域网调试规则。' }
        }
        exit 0
    }
    $physicalIndexes = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty ifIndex)
    $lanInterfaces = @(Get-NetIPConfiguration | Where-Object {
        $physicalIndexes -contains $_.InterfaceIndex -and $_.IPv4DefaultGateway -and
        @($_.IPv4Address | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' }).Count -gt 0
    } | Select-Object -ExpandProperty InterfaceAlias -Unique)
    if (-not $lanInterfaces.Count) { throw '未找到已连接且有网关的局域网物理网卡，请先连接 Wi-Fi 或网线。' }
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    if ($CheckOnly) {
        [pscustomobject]@{ Rule=$ruleName; Program=$nodeExecutable; Protocol='TCP'; LocalPort=$Port;
            RemoteAddress='LocalSubnet'; InterfaceAlias=($lanInterfaces -join ', '); Profiles='Private, Public' } | Format-List
        exit 0
    }
    $existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.Group -ne 'Huzilvsuo Local Development') { throw '同名防火墙规则不属于本工具，未覆盖。' }
        Remove-NetFirewallRule -Name $ruleName
    }
    New-NetFirewallRule -Name $ruleName -DisplayName ('沪紫小程序真机调试 TCP ' + $Port) `
        -Group 'Huzilvsuo Local Development' -Direction Inbound -Action Allow -Enabled True `
        -Protocol TCP -LocalPort $Port -Program $nodeExecutable -RemoteAddress LocalSubnet `
        -InterfaceAlias $lanInterfaces -Profile Private,Public -EdgeTraversalPolicy Block | Out-Null
    Write-Host ('已放行 TCP ' + $Port + '：仅 Node.js、当前局域网物理网卡、同一子网。防火墙保持开启。')
    Write-Host '请用同一 Wi-Fi 的手机浏览器打开启动器给出的 /api/health 地址，然后重新编译并扫码真机调试。'
} catch {
    Write-Host ('防火墙设置未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
