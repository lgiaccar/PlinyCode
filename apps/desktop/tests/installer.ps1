param([Parameter(Mandatory=$true)][string]$Installer, [string]$PreviousInstaller)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$scratch = Join-Path $repo 'ai_output'
$installRoot = Join-Path $scratch ('desktop-install-' + [guid]::NewGuid().ToString('N'))
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
function Get-PlinyInstall {
    Get-ItemProperty $registry -ErrorAction SilentlyContinue | Where-Object DisplayName -Like 'PlinyCode Desktop*'
}
function Get-InstalledFolder($entry) {
    if ($entry.UninstallString -notmatch '^"([^"]+\\Uninstall PlinyCode Desktop\.exe)" /currentuser(?: /S)?$') { throw 'Unexpected uninstaller registration; refusing to use it.' }
    [IO.Path]::GetFullPath((Split-Path -Parent $Matches[1])).TrimEnd('\')
}
if (Get-PlinyInstall) { throw 'An existing PlinyCode Desktop installation is present; refusing to replace it in a test.' }
$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'PlinyCode Desktop.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'PlinyCode Desktop.lnk')
)
foreach ($shortcut in $shortcuts) {
    if (Test-Path -LiteralPath $shortcut) { throw "An existing shortcut would be replaced: $shortcut" }
}
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$previousExecutable = $env:PLINY_DESKTOP_EXECUTABLE
$previousPrOnly = $env:PLINY_DESKTOP_E2E_PR_ONLY
$previousUpgradeData = $env:PLINY_DESKTOP_UPGRADE_DATA
$installed = $false
try {
    # NSIS consumes /D as the final argument, including any spaces in the path.
    $firstInstaller = if ($PreviousInstaller) { (Resolve-Path -LiteralPath $PreviousInstaller).Path } else { $installerPath }
    $process = Start-Process -FilePath $firstInstaller -ArgumentList "/S /D=$installRoot" -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(180000)) { throw 'Installer did not finish within three minutes.' }
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
    $registered = @(Get-PlinyInstall)
    if ($registered.Count -ne 1) { throw 'Installer did not register exactly one per-user installation.' }
    $actual = Get-InstalledFolder $registered[0]
    if ($actual -ne [IO.Path]::GetFullPath($installRoot).TrimEnd('\')) { throw "Unexpected installation location; left untouched: $actual" }
    $installed = $true
    foreach ($file in @('PlinyCode Desktop.exe', 'resources/runtime/bun.exe', 'resources/worker.js', 'resources/probe.js', 'resources/command-worker.js', 'resources/browser-extension/manifest.json', 'resources/licenses/THIRD-PARTY-NOTICES.txt', 'resources/licenses/BUN-LICENSE.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot $file))) { throw "Missing installed resource: $file" }
    }
    foreach ($shortcut in $shortcuts) {
        if (-not (Test-Path -LiteralPath $shortcut)) { throw "Missing installed shortcut: $shortcut" }
    }
    $env:PLINY_DESKTOP_EXECUTABLE = Join-Path $installRoot 'PlinyCode Desktop.exe'
    Remove-Item Env:PLINY_DESKTOP_E2E_PR_ONLY -ErrorAction SilentlyContinue
    if ($PreviousInstaller) {
        $env:PLINY_DESKTOP_UPGRADE_DATA = Join-Path $scratch ('desktop-upgrade-' + [guid]::NewGuid().ToString('N'))
        & node --experimental-strip-types (Join-Path $PSScriptRoot 'upgrade.ts') seed
        if ($LASTEXITCODE -ne 0) { throw 'Old-version conversation setup failed.' }
        $process = Start-Process -FilePath $installerPath -ArgumentList "/S /D=$installRoot" -WindowStyle Hidden -PassThru
        if (-not $process.WaitForExit(180000) -or $process.ExitCode -ne 0) { throw 'Upgrade installer failed.' }
        $registered = @(Get-PlinyInstall)
        if ($registered.Count -ne 1 -or (Get-InstalledFolder $registered[0]) -ne $actual) { throw 'Upgrade changed the installation identity.' }
        & node --experimental-strip-types (Join-Path $PSScriptRoot 'upgrade.ts') verify
        if ($LASTEXITCODE -ne 0) { throw 'Upgraded conversation verification failed.' }
    }
    & node --experimental-strip-types (Join-Path $PSScriptRoot 'e2e.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Installed application acceptance tests failed.' }
    Write-Output 'PASS: one-click installer payload, per-user registration, shortcuts and installed application E2E.'
} finally {
    $env:PLINY_DESKTOP_EXECUTABLE = $previousExecutable
    $env:PLINY_DESKTOP_E2E_PR_ONLY = $previousPrOnly
    $env:PLINY_DESKTOP_UPGRADE_DATA = $previousUpgradeData
    if ($installed) {
        # Revalidate the exact path before an uninstaller can remove anything.
        $resolved = [IO.Path]::GetFullPath($installRoot)
        if (-not $resolved.StartsWith([IO.Path]::GetFullPath($scratch) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Uninstall target escaped the test workspace.' }
        $registered = @(Get-PlinyInstall)
        if ($registered.Count -ne 1 -or (Get-InstalledFolder $registered[0]) -ne $resolved.TrimEnd('\')) { throw 'Installation registration changed during the test; refusing to uninstall.' }
        $uninstaller = Join-Path $installRoot 'Uninstall PlinyCode Desktop.exe'
        $process = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installRoot" -WindowStyle Hidden -PassThru
        if (-not $process.WaitForExit(120000)) { throw 'Uninstaller did not finish within two minutes.' }
        if ($process.ExitCode -ne 0 -or (Get-PlinyInstall) -or (Test-Path -LiteralPath (Join-Path $installRoot 'PlinyCode Desktop.exe'))) { throw 'Uninstaller did not remove the test installation.' }
        foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw "Uninstaller left a shortcut: $shortcut" } }
        Write-Output 'PASS: uninstaller removed the test application, shortcuts and registration.'
    }
}
