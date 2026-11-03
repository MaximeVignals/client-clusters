# Client Clusters updater: replaces resources\app.asar with the one from an update package.
# Usage: drop a ClientClusters-<version>-update.zip on "Update Client Clusters.bat",
# or run the .bat and it picks the newest update package from Downloads or this folder.
param([string]$Package)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$appDir = $PSScriptRoot
$res = Join-Path $appDir 'resources'
$asarPath = Join-Path $res 'app.asar'
function Fail($msg) { Write-Host "`n$msg" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

if (-not (Test-Path $asarPath)) { Fail "This script must stay in the Client Clusters folder (no resources\app.asar found here)." }

if (-not $Package) {
  $places = @((Join-Path $env:USERPROFILE 'Downloads'), $appDir)
  $Package = Get-ChildItem -Path $places -Filter 'ClientClusters-*-update.zip' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $Package) { Fail "No update package found. Put ClientClusters-<version>-update.zip in Downloads, or drop it on this file." }
}
Write-Host "Update package: $Package"

$zip = [System.IO.Compression.ZipFile]::OpenRead($Package)
try {
  $infoEntry = $zip.GetEntry('update.json'); $asarEntry = $zip.GetEntry('app.asar')
  if (-not $infoEntry -or -not $asarEntry) { Fail "This is not a Client Clusters update package." }
  $reader = New-Object System.IO.StreamReader($infoEntry.Open()); $info = $reader.ReadToEnd() | ConvertFrom-Json; $reader.Close()
  $tmp = Join-Path $res 'app.asar.new'
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($asarEntry, $tmp, $true)
} finally { $zip.Dispose() }

# Same Electron version, or the new code may not run: then the full install is needed.
$evFile = Join-Path $res 'electron-version.txt'
$installed = if (Test-Path $evFile) { (Get-Content $evFile -Raw).Trim() } else { '' }
if ($installed -ne $info.electron) {
  Remove-Item $tmp -Force
  Fail "Version $($info.version) needs Electron $($info.electron), this install has $(if ($installed) { $installed } else { 'an unknown version' }). Install the full package (ClientClusters-$($info.version)-win-x64.7z) instead."
}

$hash = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $info.sha256) { Remove-Item $tmp -Force; Fail "The update package is damaged (checksum does not match). Download it again." }

$running = Get-Process -Name 'Client Clusters' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($appDir) }
if ($running) {
  Write-Host 'Closing Client Clusters...'
  $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 3
  Get-Process -Name 'Client Clusters' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($appDir) } | Stop-Process -Force
  Start-Sleep -Seconds 1
}

# Keep the previous version so it can be put back by hand (rename app.asar.previous to app.asar).
Copy-Item $asarPath (Join-Path $res 'app.asar.previous') -Force
Move-Item $tmp $asarPath -Force
Write-Host "`nClient Clusters updated to version $($info.version)." -ForegroundColor Green
Start-Process (Join-Path $appDir 'Client Clusters.exe')
Start-Sleep -Seconds 2
