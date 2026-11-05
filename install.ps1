# Installs the latest DocBro from GitHub Releases on Windows.
#   irm https://raw.githubusercontent.com/jetorbitdev/docbro/main/install.ps1 | iex
#
# Runs the NSIS setup silently. It installs for the current user, so no administrator
# prompt. The download is checked against the SHA-256 digest GitHub records for the asset.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'jetorbitdev/docbro'

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
    # ARM64 Windows runs x64 apps under emulation, so only 32-bit Windows is turned away.
    if ($env:PROCESSOR_ARCHITECTURE -ne 'ARM64') { throw 'DocBro needs 64-bit Windows.' }
}

try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" `
        -Headers @{ Accept = 'application/vnd.github+json' }
} catch {
    throw "Couldn't reach GitHub, or DocBro has no published release yet."
}

$asset = $release.assets | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1
if (-not $asset) { throw "The latest release ($($release.tag_name)) has no Windows setup file." }

$file = Join-Path ([IO.Path]::GetTempPath()) $asset.name
Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing

try {
    if ($asset.digest -like 'sha256:*') {
        Write-Host 'Verifying checksum...'
        $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $asset.digest.Substring(7)) { throw "Checksum mismatch for $($asset.name), aborting." }
    } else {
        Write-Warning "GitHub has no checksum for $($asset.name), skipping verification."
    }

    Get-Process DocBro -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host 'Installing...'
    $proc = Start-Process $file -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "The installer exited with code $($proc.ExitCode)." }
} finally {
    Remove-Item $file -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed DocBro $($release.tag_name). Open it from the Start menu."
