# Watches Stremio's streaming server (port 11470) and ties the offline addon's
# lifecycle to it: starts addon.js when Stremio comes up, stops it when Stremio
# goes away. Registered to run hidden at login. Manual run is fine too.
$ErrorActionPreference = 'SilentlyContinue'

$Runtime     = 'C:\Users\hbar\AppData\Local\Programs\Stremio\stremio-runtime.exe'
$AddonDir    = 'C:\Users\hbar\Desktop\streamio\stremio-offline-addon'
$AddonJs     = Join-Path $AddonDir 'addon.js'
$StremioPort = 11470
$AddonPort   = 11473
$PollSeconds = 5
$DownMisses  = 2   # require this many consecutive 11470-down polls before killing
$LogFile     = Join-Path $AddonDir 'data\watcher.log'

function Log($m) { "{0}  {1}" -f (Get-Date -Format s), $m | Out-File -FilePath $LogFile -Append -Encoding utf8 }
function PortListening($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function AddonPid { (Get-NetTCPConnection -LocalPort $AddonPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }

Log "watcher started (pid $PID)"
$miss = 0

while ($true) {
    $stremioUp = PortListening $StremioPort
    $apid      = AddonPid

    if ($stremioUp) {
        $miss = 0
        if (-not $apid) {
            Log "Stremio up (11470), addon not running -> starting addon"
            Start-Process -FilePath $Runtime -ArgumentList ('"{0}"' -f $AddonJs) -WorkingDirectory $AddonDir -WindowStyle Hidden
        }
    } else {
        if ($apid) {
            $miss++
            if ($miss -ge $DownMisses) {
                Log "Stremio down (11470) x$miss, stopping addon pid $apid"
                Stop-Process -Id $apid -Force -ErrorAction SilentlyContinue
                $miss = 0
            }
        } else {
            $miss = 0
        }
    }

    Start-Sleep -Seconds $PollSeconds
}
