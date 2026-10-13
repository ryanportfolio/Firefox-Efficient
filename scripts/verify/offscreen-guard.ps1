param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [int]$X = -2400,
  [int]$Y = -2400,
  [switch]$Trace
)
# Keeps the test Firefox's top-level windows off every display.
# Firefox clamps a new window's position onto a screen, so a fresh test window first shows up on one of
# the user's displays until WebDriver moves it. This helper listens for window create, show and move events and
# moves any non-minimized, non-maximized Firefox top-level window (classes MozillaWindowClass and
# MozillaDialogClass; shown or not yet shown) that is a descendant of
# RootPid (the geckodriver process) to X,Y as soon as it lands on a display. Other processes' windows
# are never touched. Exits when RootPid exits. Prints READY once the hook is set.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OffscreenGuard {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjects(uint n, IntPtr[] handles, bool all, uint ms, uint mask);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESSENTRY32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
    public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  const uint EVENT_OBJECT_CREATE = 0x8000, EVENT_OBJECT_SHOW = 0x8002, EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
  const uint WINEVENT_OUTOFCONTEXT = 0, WINEVENT_SKIPOWNPROCESS = 2;
  const uint SWP_NOSIZE = 1, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10;
  static uint rootPid; static int targetX, targetY;
  static Dictionary<uint, bool> ownedCache = new Dictionary<uint, bool>();
  static WinEventProc proc = OnEvent;
  public static int Moves = 0;

  static bool IsOwned(uint pid) {
    bool known;
    if (ownedCache.TryGetValue(pid, out known)) return known;
    var parents = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    var e = new PROCESSENTRY32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
    if (Process32FirstW(snap, ref e)) { do { parents[e.th32ProcessID] = e.th32ParentProcessID; } while (Process32NextW(snap, ref e)); }
    CloseHandle(snap);
    bool owned = false; uint cur = pid;
    for (int i = 0; i < 6 && parents.ContainsKey(cur); i++) {
      cur = parents[cur];
      if (cur == rootPid) { owned = true; break; }
    }
    ownedCache[pid] = owned;
    return owned;
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (idObject != 0 || hwnd == IntPtr.Zero) return;
    if (GetAncestor(hwnd, 2) != hwnd) return; // top-level only
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    if (!IsOwned(pid)) return;
    var sb = new StringBuilder(64); GetClassName(hwnd, sb, 64);
    RECT r; if (!GetWindowRect(hwnd, out r)) return;
    if (Trace) Log("event=0x" + ev.ToString("X") + " class=" + sb + " rect=" + r.L + "," + r.T + "," + (r.R - r.L) + "x" + (r.B - r.T) + " visible=" + IsWindowVisible(hwnd) + " iconic=" + IsIconic(hwnd));
    // Hidden windows count too: Firefox positions a new window before showing it.
    if (IsIconic(hwnd) || IsZoomed(hwnd)) return;
    string cls = sb.ToString();
    if (cls != "MozillaWindowClass" && cls != "MozillaDialogClass") return; // browser windows; popup-type windows and dialogs
    if (r.R - r.L < 100 || r.B - r.T < 100) return;
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    bool onScreen = r.L < vx + vw && r.R > vx && r.T < vy + vh && r.B > vy;
    if (!onScreen) return;
    SetWindowPos(hwnd, IntPtr.Zero, targetX, targetY, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    Moves++;
    Log("moved pid=" + pid + " from=" + r.L + "," + r.T + " visible=" + IsWindowVisible(hwnd));
  }

  public static bool Trace = false;
  static void Log(string line) {
    Console.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " " + line);
    Console.Out.Flush();
  }

  public static void Run(int root, int x, int y) {
    rootPid = (uint)root; targetX = x; targetY = y;
    IntPtr proc1 = OpenProcess(0x00100000 /* SYNCHRONIZE */, false, rootPid);
    if (proc1 == IntPtr.Zero) throw new Exception("cannot open process " + root);
    SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    Console.WriteLine("READY");
    Console.Out.Flush();
    var handles = new IntPtr[] { proc1 };
    while (true) {
      uint r = MsgWaitForMultipleObjects(1, handles, false, 0xFFFFFFFF, 0x04FF /* QS_ALLINPUT */);
      if (r == 0) break; // root process exited
      MSG m;
      while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessage(ref m); }
    }
    CloseHandle(proc1);
  }
}
"@
[OffscreenGuard]::Trace = [bool]$Trace
[OffscreenGuard]::Run($RootPid, $X, $Y)
"EXIT moves=$([OffscreenGuard]::Moves)"
