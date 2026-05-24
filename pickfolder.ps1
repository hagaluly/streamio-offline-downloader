param([string]$initial)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinApi {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  public static IntPtr FindDialog(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint wp; GetWindowThreadProcessId(h, out wp);
      if (wp == pid && IsWindowVisible(h)) {
        StringBuilder sb = new StringBuilder(64);
        GetClassName(h, sb, 64);
        if (sb.ToString() == "#32770") { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Bring(IntPtr h) {
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0003); // HWND_TOPMOST | NOSIZE | NOMOVE
    BringWindowToTop(h);
    SetForegroundWindow(h);
  }
}
"@
Add-Type -TypeDefinition $src

$myPid = [System.Diagnostics.Process]::GetCurrentProcess().Id

# Background watcher: once the folder dialog appears, force it topmost + foreground.
$rs = [runspacefactory]::CreateRunspace()
$rs.Open()
$rs.SessionStateProxy.SetVariable('myPid', $myPid)
$psw = [powershell]::Create()
$psw.Runspace = $rs
$psw.AddScript({
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 100
    $h = [WinApi]::FindDialog([uint32]$myPid)
    if ($h -ne [IntPtr]::Zero) { [WinApi]::Bring($h) }
  }
}) | Out-Null
$psw.BeginInvoke() | Out-Null

$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.AutoUpgradeEnabled = $false   # classic "Browse For Folder" (class #32770, findable)
$f.Description = 'Choose the Stremio downloads folder'
$f.ShowNewFolderButton = $true
if ($initial) { try { $f.SelectedPath = $initial } catch {} }
$r = $f.ShowDialog()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [System.Console]::Out.Write($f.SelectedPath) }
