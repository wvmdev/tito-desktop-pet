# Opens an application by name, the way the Start menu would: "Edge", "Notepad", "Calculator", "Spotify"...
# Usage: powershell -File open-app.ps1 <name>      Exit code 0 = started, 1 = not found (message on stderr).
param([Parameter(Mandatory = $true)][string]$Name)
$ErrorActionPreference = 'Stop'
try {
    # 1. An app in the Start menu (desktop apps and Store apps alike): best match = exact name, then shortest.
    $apps = @(Get-StartApps | Where-Object { $_.Name.IndexOf($Name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($apps.Count -gt 0) {
        $app = $apps | Sort-Object @{ Expression = { if ($_.Name -ieq $Name) { 0 } else { 1 } } }, @{ Expression = { $_.Name.Length } } | Select-Object -First 1
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $app.AppID)
        exit 0
    }
    # 2. Anything Windows can resolve by name: notepad, calc, mspaint, chrome (App Paths)...
    Start-Process -FilePath $Name
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
