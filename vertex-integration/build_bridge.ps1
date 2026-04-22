$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$vsPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
$msvcVer = (Get-ChildItem $vsPath | Sort-Object Name -Descending | Select-Object -First 1).Name
$vcBin = "$vsPath\$msvcVer\bin\Hostx64\x64"
$env:PATH = "$vcBin;$env:PATH"
Write-Host "Using cargo: $cargo"
Write-Host "Using MSVC: $vcBin"
& $cargo build --bin vertex_bridge --target x86_64-pc-windows-msvc
Write-Host "Build exit code: $LASTEXITCODE"
