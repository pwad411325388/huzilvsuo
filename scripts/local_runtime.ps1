# Loading these startup helpers never starts or stops a process.
function Test-PrivateIPv4([string]$Address) {
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $bytes = $parsed.GetAddressBytes()
    return $bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

function Select-LanCandidate($Candidates, [string]$PreferredAddress = '') {
    $eligible = @($Candidates | Where-Object {
        $_.Status -eq 'Up' -and $_.HardwareInterface -and $_.InterfaceType -in @(6, 71) -and
        $_.Gateway -and $_.Gateway -ne '0.0.0.0' -and (Test-PrivateIPv4 $_.Address) -and
        ($_.Name + ' ' + $_.Description) -notmatch 'VPN|Virtual|Hyper-V|TAP|TUN|WireGuard|Tailscale|ZeroTier|VMware|VBox|Loopback|Bluetooth'
    } | Sort-Object @{ Expression = { [int]$_.RouteMetric + [int]$_.InterfaceMetric } },
        @{ Expression = { [int]$_.InterfaceMetric } }, @{ Expression = { [int]$_.InterfaceIndex } }, Address)
    if ($PreferredAddress) { $eligible = @($eligible | Where-Object { $_.Address -eq $PreferredAddress }) }
    if (-not $eligible.Count) {
        throw '未找到有默认网关的物理 Wi-Fi / 以太网内网 IPv4。请连接路由器网络；指定的 -LanAddress 必须属于该网卡。'
    }
    return $eligible[0]
}

function Get-LanCandidates {
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)
    foreach ($adapter in @(Get-NetAdapter -Physical)) {
        if ($adapter.Status -ne 'Up') { continue }
        $route = $routes | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex } | Sort-Object RouteMetric | Select-Object -First 1
        if (-not $route) { continue }
        $interface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $adapter.ifIndex | Select-Object -First 1
        foreach ($address in @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $adapter.ifIndex | Where-Object {
            $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource
        })) {
            [pscustomobject]@{ Address = $address.IPAddress; Gateway = $route.NextHop; Status = $adapter.Status;
                HardwareInterface = $adapter.HardwareInterface; InterfaceType = $adapter.InterfaceType;
                Name = $adapter.Name; Description = $adapter.InterfaceDescription; InterfaceIndex = $adapter.ifIndex;
                RouteMetric = $route.RouteMetric; InterfaceMetric = $interface.InterfaceMetric }
        }
    }
}

function Test-OwnedServer($Manifest, $ProcessInfo, [string]$ServerPath, [int]$Port) {
    if (-not $Manifest -or -not $ProcessInfo) { return $false }
    try {
        $script = [IO.Path]::GetFullPath($ServerPath)
        $command = [string]$ProcessInfo.CommandLine
        return [int]$Manifest.pid -eq [int]$ProcessInfo.ProcessId -and [int]$Manifest.port -eq $Port -and
            [IO.Path]::GetFullPath([string]$Manifest.script) -eq $script -and
            [string]$Manifest.executable -eq [string]$ProcessInfo.ExecutablePath -and
            [string]$Manifest.startedAt -eq $ProcessInfo.CreationDate.ToUniversalTime().ToString('o') -and
            $command -match ('(?:^|\s)"' + [regex]::Escape($script) + '"(?:\s|$)')
    } catch { return $false }
}

function Write-LocalJson([string]$Path, $Value) {
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}
