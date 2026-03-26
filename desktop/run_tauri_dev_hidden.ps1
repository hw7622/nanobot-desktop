$srcTauri = Join-Path $PSScriptRoot 'src-tauri'
$logPath = Join-Path $PSScriptRoot '.tauri-dev.log'

Start-Process `
  -FilePath 'powershell.exe' `
  -WorkingDirectory $srcTauri `
  -WindowStyle Hidden `
  -ArgumentList '-NoLogo','-NoProfile','-Command',("cargo tauri dev --no-watch *> '{0}'" -f $logPath) | Out-Null
