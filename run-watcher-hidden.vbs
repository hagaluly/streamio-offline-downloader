' Launches the addon watcher fully hidden (no console flash). Used by the
' "Stremio Offline Addon Watcher" scheduled task at login.
CreateObject("Wscript.Shell").Run _
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\hbar\Desktop\streamio\stremio-offline-addon\watch-addon.ps1""", _
  0, False
