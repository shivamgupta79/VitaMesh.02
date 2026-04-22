$vsPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
$ver = (Get-ChildItem $vsPath | Sort-Object Name -Descending | Select-Object -First 1).Name
$env:PATH = "$vsPath\$ver\bin\Hostx64\x64;$env:PATH"
Write-Host "[vertex] Starting Rust bridge..."
& ".\target\x86_64-pc-windows-msvc\debug\vertex_bridge.exe"
