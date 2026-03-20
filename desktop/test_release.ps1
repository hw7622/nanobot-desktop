param(
    [switch]$DebugBuild,
    [switch]$NoRun,
    [switch]$SkipPythonBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    Write-Host "`n==> $Label" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Label (exit code $LASTEXITCODE)"
    }
}

$desktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $desktopDir
$tauriDir = Join-Path $desktopDir 'src-tauri'
$targetDir = if ($DebugBuild) { 'debug' } else { 'release' }
$appExe = Join-Path $tauriDir "target\$targetDir\nanobot-desktop.exe"

Write-Host "Repo Root : $repoRoot"
Write-Host "Desktop Dir: $desktopDir"
Write-Host "Build Type : $(if ($DebugBuild) { 'debug' } else { 'release' })"

if (-not $SkipPythonBuild) {
    Invoke-Step 'Build desktop backend bundle' {
        Set-Location $repoRoot
        python (Join-Path $desktopDir 'build_backend.py')
    }

    Invoke-Step 'Build nanobot runtime bundle' {
        Set-Location $repoRoot
        python (Join-Path $desktopDir 'build_runtime.py')
    }
}

Invoke-Step 'Build Tauri desktop app' {
    Set-Location $tauriDir
    if ($DebugBuild) {
        cargo tauri build --debug
    } else {
        cargo tauri build
    }
}

if (-not (Test-Path $appExe)) {
    throw "Built app not found: $appExe"
}

Write-Host "`nBuilt app: $appExe" -ForegroundColor Green

if (-not $NoRun) {
    Write-Host 'Launching desktop app...' -ForegroundColor Green
    Start-Process -FilePath $appExe | Out-Null
}
