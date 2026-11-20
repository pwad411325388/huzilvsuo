# 手机真机连接电脑后台

手机上的 `127.0.0.1` 代表手机自己，不能连接电脑。真机调试需要电脑和手机在同一局域网，并把小程序接口改为电脑的局域网地址。

1. 在项目根目录双击 **启动真机调试.cmd**。它检测已连接、有网关的物理 Wi-Fi / 有线网卡，排除 VPN、虚拟网卡和无效地址，启动局域网监听并更新 `miniprogram/network-config.js`。只有服务健康后才保存配置，不改数据库、账号或密码。
2. 手机连接与电脑相同的 Wi-Fi，在手机浏览器打开启动器显示的 **手机连接检查**地址（格式为 `http://电脑IP:7101/api/health`）。看到 JSON 中的 `"mode":"local"` 才说明手机已连到电脑。电脑用自己的局域网 IP 打开成功，只证明电脑侧服务可用，不能代替这一步。
3. 若手机连接检查打不开，先核对 Wi-Fi 和启动器地址；检查是否使用了访客 Wi-Fi、AP 隔离或 VPN。Windows 防火墙可能需要放行：右键 **放行真机调试端口.cmd**，选择 **以管理员身份运行**。脚本只允许 Node.js 的 TCP 7101、当前已连接物理局域网接口、`LocalSubnet` 来源，兼容专用/公用网络；不关闭防火墙，不修改其他程序规则。没有管理员权限时会明确提示并退出。
4. 在微信开发者工具重新点击 **编译**，再点击 **真机调试**并重新扫码，使用原来的业务账号密码。不要继续使用之前已加载旧地址的调试页面。项目及个人项目配置的 `setting.urlCheck` 当前均为 `false`；如果手机仍报告域名校验错误，再核对工具的本地调试设置。

电脑后台仍使用 `http://127.0.0.1:7101/admin`。局域网地址只用于手机业务调试；远端不能打开管理后台、登录管理员或用管理员会话读取数据，也不能重置管理员密码。

## 地址变化和恢复电脑模式

启动器成功启用真机模式后，会将模式保存在被 Git 忽略的 `.runtime/startup-config.json`。以后双击本地启动器或 Windows 登录自动启动时沿用该模式，并重新检测电脑当前 IP。切换 Wi-Fi 后重新启动真机调试并重新编译小程序。

多网卡情况下可以显式选择当前物理网卡地址：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start_local.ps1 -Lan -LanAddress 192.168.1.100
```

恢复仅电脑可访问并把小程序配置改回回环：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start_local.ps1 -LocalOnly
```

可选：以管理员身份删除本工具创建的防火墙规则：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/configure_lan_firewall.ps1 -Remove
```

所有模式使用原 `.runtime/demo.sqlite`。启动器只会停止身份可核准的本项目进程；旧服务或其他程序占用端口且无法核准时会提示，不会任意关闭 Node.js。日志位于 `.runtime/`。

## 配置与上线

`miniprogram/network-config.js` 仅包含 `apiBase`，不放密码、令牌或数据库信息；文件本身随代码提供，干净检出也可编译。局域网启动器会更新本机工作区的值。正式版必须将 `apiBase` 设为部署后的公网 HTTPS `/api` 地址，并完成微信服务域名配置；正式版和无法确认运行版本时，客户端会阻止调试 HTTP、回环和私网地址。

本地自动化覆盖配置校验、请求地址与失败提示、服务端角色权限和监听切换。手机实际 Wi-Fi 连通、微信扫码后的登录需在手机上验证，不能由电脑端测试替代。
