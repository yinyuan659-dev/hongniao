# 用本机 Edge 无界面模式给样稿截图。用法：.\shot.ps1 01-ai-interview a 1120
# 参数：样稿文件名（不带 .html）、哪一组（a / b / c / d）、截图高度（像素）
param([string]$name, [string]$part, [int]$height = 1120)
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'file:///' + ($dir -replace '\\', '/') + "/$name.html?only=$part"
$out = Join-Path $dir "$name-$part.png"
& $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 "--window-size=860,$height" "--screenshot=$out" $url 2>$null | Out-Null
Get-Item $out | Select-Object Name, Length
