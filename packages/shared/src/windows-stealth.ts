/**
 * Windows zero-restart stealth window virtualization & browser mode persistence.
 *
 * On Windows, "headless" mode for the managed browser defaults to Win32 window
 * virtualization ("stealth") rather than Chromium's `--headless=new`:
 *   - Chrome launches as a normal GUI process with occlusion/background-throttling
 *     disabled so `Page.captureScreenshot`, `requestAnimationFrame`, WebGL, and
 *     anti-bot fingerprints behave identically to a foreground desktop browser.
 *   - Hiding moves top-level `Chrome_WidgetWin_1` windows off-screen (-32000,-32000)
 *     while keeping normal width/height, strips `WS_EX_APPWINDOW`, applies
 *     `WS_EX_TOOLWINDOW | WS_EX_LAYERED (alpha=0) | WS_EX_NOACTIVATE`, and
 *     re-asserts `SW_SHOWNOACTIVATE` so Windows removes the taskbar & Alt+Tab
 *     entries while Chromium's Aura compositor stays active (`IsWindowVisible=true`).
 *   - Window metadata (`MaBrowserStealth` + original placement & extended style)
 *     is stored directly on each HWND via Win32 `SetPropW`, so state survives
 *     even if the daemon or helper process restarts.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { hintFromArgs, splitCommandLine } from "./process-hints.js";

export type BrowserDisplayMode = "headed" | "headless";

export interface PersistedBrowserMode {
  mode: BrowserDisplayMode;
  updatedAt: string;
}

export interface WindowModeStatusResult {
  trayRunning: boolean;
  windowCount: number;
  stealth: boolean;
}

export interface WindowModeApplyResult {
  trayRunning: boolean;
  affectedCount: number;
  focused?: boolean;
}

export interface BrowserProcessMatch {
  pid: number;
  userDataDir?: string;
}

export interface WindowModeDriver {
  status(pid?: number | null, windowClass?: string): Promise<WindowModeStatusResult>;
  hide(pid: number, windowClass?: string): Promise<WindowModeApplyResult>;
  show(pid: number, focus?: boolean, windowClass?: string): Promise<WindowModeApplyResult>;
  findManagedPid?(port: number, profileDir: string): Promise<number | null>;
  findBrowserProcess?(port: number): Promise<BrowserProcessMatch | null>;
  close?(): void;
}

function resolveHomeDir(homeDir?: string): string {
  return homeDir ?? process.env.BB_BROWSER_HOME ?? path.join(homedir(), ".bb-browser");
}

export function managedModeFilePath(homeDir?: string): string {
  return path.join(resolveHomeDir(homeDir), "browser", "mode.json");
}

/** Read the persisted browser mode (`headed` | `headless`), or null if unset. */
export function readPersistedBrowserMode(homeDir?: string): BrowserDisplayMode | null {
  try {
    const raw = readFileSync(managedModeFilePath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedBrowserMode>;
    if (parsed.mode === "headed" || parsed.mode === "headless") {
      return parsed.mode;
    }
  } catch {
    // missing or malformed
  }
  return null;
}

/** Persist the user's chosen browser mode atomically to `browser/mode.json`. */
export function writePersistedBrowserMode(mode: BrowserDisplayMode, homeDir?: string): void {
  const file = managedModeFilePath(homeDir);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ mode, updatedAt: new Date().toISOString() } satisfies PersistedBrowserMode);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, payload, "utf8");
  }
}

/**
 * Determine the desired mode when launching a managed browser:
 *   1. Explicit `MA_BROWSER_HEADLESS=1|0` env var
 *   2. Persisted `browser/mode.json`
 *   3. `MA_BROWSER_DEFAULT_MODE=headless|headed` (set by Windows tray)
 *   4. Default `"headed"`
 */
export function resolveInitialBrowserMode(homeDir?: string): {
  mode: BrowserDisplayMode;
  nativeHeadless: boolean;
} {
  let mode: BrowserDisplayMode;
  if (process.env.MA_BROWSER_HEADLESS === "1") {
    mode = "headless";
  } else if (process.env.MA_BROWSER_HEADLESS === "0") {
    mode = "headed";
  } else {
    const saved = readPersistedBrowserMode(homeDir);
    if (saved) {
      mode = saved;
    } else if (process.env.MA_BROWSER_DEFAULT_MODE === "headless") {
      mode = "headless";
    } else {
      mode = "headed";
    }
  }

  const nativeHeadless =
    mode === "headless" &&
    (process.platform !== "win32" || process.env.MA_BROWSER_NATIVE_HEADLESS === "1");

  return { mode, nativeHeadless };
}

// ---------------------------------------------------------------------------
// Resident PowerShell Win32 Bridge (Windows PowerShell 5.1 / C# 5 compatible)
// ---------------------------------------------------------------------------

const PS_WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MaBrowserStealthWin32 {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int maxCount);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint crKey, byte bAlpha, uint dwFlags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, out RECT pvParam, uint fWinIni);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetPropW(IntPtr hWnd, string lpString, IntPtr hData);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetPropW(IntPtr hWnd, string lpString);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr RemovePropW(IntPtr hWnd, string lpString);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  const uint GW_OWNER = 4;
  const int GWL_STYLE = -16;
  const int GWL_EXSTYLE = -20;
  const long WS_VISIBLE = 0x10000000L;
  const long WS_EX_TOOLWINDOW = 0x00000080L;
  const long WS_EX_APPWINDOW = 0x00040000L;
  const long WS_EX_LAYERED = 0x00080000L;
  const long WS_EX_NOACTIVATE = 0x08000000L;
  const uint LWA_ALPHA = 0x00000002;

  const int SW_HIDE = 0;
  const int SW_SHOWNORMAL = 1;
  const int SW_SHOWMAXIMIZED = 3;
  const int SW_SHOWNOACTIVATE = 4;
  const int SW_SHOW = 5;
  const int SW_RESTORE = 9;

  const uint SWP_NOZORDER = 0x0004;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint SWP_FRAMECHANGED = 0x0020;
  const uint SPI_GETWORKAREA = 0x0030;

  const string PROP_STEALTH = "MaBrowserStealth";
  const string PROP_HAS_RECT = "MaBrowserHasRect";
  const string PROP_X = "MaBrowserOrigX";
  const string PROP_Y = "MaBrowserOrigY";
  const string PROP_W = "MaBrowserOrigW";
  const string PROP_H = "MaBrowserOrigH";
  const string PROP_MAX = "MaBrowserOrigMax";
  const string PROP_EX = "MaBrowserOrigEx";

  static long GetStyle(IntPtr hWnd) {
    return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, GWL_STYLE).ToInt64() : (long)GetWindowLong32(hWnd, GWL_STYLE);
  }

  static long GetExStyle(IntPtr hWnd) {
    return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, GWL_EXSTYLE).ToInt64() : (long)GetWindowLong32(hWnd, GWL_EXSTYLE);
  }

  static void SetExStyle(IntPtr hWnd, long value) {
    if (IntPtr.Size == 8) SetWindowLongPtr64(hWnd, GWL_EXSTYLE, new IntPtr(value));
    else SetWindowLong32(hWnd, GWL_EXSTYLE, unchecked((int)value));
  }

  public static bool IsTrayRunning() {
    Mutex m;
    if (Mutex.TryOpenExisting("Local\\ma-browser-tray", out m)) {
      m.Dispose();
      return true;
    }
    return false;
  }

  static List<IntPtr> FindTargetWindows(uint pid, string classFilter) {
    List<IntPtr> list = new List<IntPtr>();
    if (pid == 0) return list;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint ownerPid;
      GetWindowThreadProcessId(h, out ownerPid);
      if (ownerPid != pid) return true;
      if (classFilter != "*" && GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
      if (!string.IsNullOrEmpty(classFilter) && classFilter != "*") {
        StringBuilder sb = new StringBuilder(128);
        GetClassNameW(h, sb, sb.Capacity);
        if (sb.ToString() != classFilter) return true;
      }
      bool isStealth = GetPropW(h, PROP_STEALTH) != IntPtr.Zero;
      if (!isStealth) {
        // Check WS_VISIBLE style bit directly so it works on both interactive WinSta0
        // desktops and non-interactive CI/SSH window stations (where IsWindowVisible is always false).
        if (!IsWindowVisible(h) && (GetStyle(h) & WS_VISIBLE) == 0) return true;
        if (GetWindowTextLengthW(h) <= 0) return true;
      }
      list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static int[] GetStatus(uint pid, string classFilter) {
    List<IntPtr> wins = FindTargetWindows(pid, classFilter);
    int stealthCount = 0;
    int normalVisibleCount = 0;
    foreach (IntPtr h in wins) {
      if (GetPropW(h, PROP_STEALTH) != IntPtr.Zero) stealthCount++;
      else normalVisibleCount++;
    }
    int isStealth = (stealthCount > 0 && normalVisibleCount == 0) ? 1 : 0;
    return new int[] { wins.Count, isStealth };
  }

  public static int HideWindows(uint pid, string classFilter) {
    List<IntPtr> wins = FindTargetWindows(pid, classFilter);
    int count = 0;
    foreach (IntPtr h in wins) {
      bool alreadyStealth = GetPropW(h, PROP_STEALTH) != IntPtr.Zero;
      long origEx;
      int w = 1280;
      int hgt = 850;

      if (!alreadyStealth) {
        WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
        wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        GetWindowPlacement(h, ref wp);
        origEx = GetExStyle(h);
        int rx = wp.rcNormalPosition.Left;
        int ry = wp.rcNormalPosition.Top;
        int rw = wp.rcNormalPosition.Right - wp.rcNormalPosition.Left;
        int rh = wp.rcNormalPosition.Bottom - wp.rcNormalPosition.Top;
        bool validRect = rx > -10000 && ry > -10000 && rw >= 200 && rh >= 150;
        if (rw >= 200 && rh >= 150) { w = rw; hgt = rh; }
        SetPropW(h, PROP_HAS_RECT, new IntPtr(validRect ? 1 : 0));
        SetPropW(h, PROP_X, new IntPtr(rx));
        SetPropW(h, PROP_Y, new IntPtr(ry));
        SetPropW(h, PROP_W, new IntPtr(w));
        SetPropW(h, PROP_H, new IntPtr(hgt));
        SetPropW(h, PROP_MAX, new IntPtr(wp.showCmd == SW_SHOWMAXIMIZED || IsZoomed(h) ? 1 : 0));
        SetPropW(h, PROP_EX, new IntPtr(origEx));

        if (IsZoomed(h) || IsIconic(h)) {
          ShowWindow(h, SW_SHOWNOACTIVATE);
        }
      } else {
        origEx = GetPropW(h, PROP_EX).ToInt64();
        int savedW = GetPropW(h, PROP_W).ToInt32();
        int savedH = GetPropW(h, PROP_H).ToInt32();
        if (savedW >= 200) w = savedW;
        if (savedH >= 150) hgt = savedH;
      }

      long stealthEx = (origEx | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE) & ~WS_EX_APPWINDOW;
      // Hide briefly so Explorer removes the taskbar button immediately, then
      // re-show without activation while WS_EX_TOOLWINDOW is set so Chromium's
      // Aura compositor stays live (avoiding screenshot/rAF stalls).
      ShowWindow(h, SW_HIDE);
      SetExStyle(h, stealthEx);
      SetLayeredWindowAttributes(h, 0, 0, LWA_ALPHA);
      SetWindowPos(h, IntPtr.Zero, -32000, -32000, w, hgt, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      ShowWindow(h, SW_SHOWNOACTIVATE);
      SetPropW(h, PROP_STEALTH, new IntPtr(1));
      count++;
    }
    return count;
  }

  static RECT DefaultCenteredRect(int prefW, int prefH) {
    RECT work;
    if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, out work, 0)) {
      work.Left = 0; work.Top = 0; work.Right = 1920; work.Bottom = 1040;
    }
    int workW = Math.Max(400, work.Right - work.Left);
    int workH = Math.Max(300, work.Bottom - work.Top);
    int w = Math.Min(prefW, workW - 40);
    int h = Math.Min(prefH, workH - 40);
    RECT r = new RECT();
    r.Left = work.Left + Math.Max(0, (workW - w) / 2);
    r.Top = work.Top + Math.Max(0, (workH - h) / 2);
    r.Right = r.Left + w;
    r.Bottom = r.Top + h;
    return r;
  }

  public static bool ForceForeground(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;
    if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
    IntPtr fg = GetForegroundWindow();
    if (fg == hWnd) return true;
    uint fgPid;
    uint targetPid;
    uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
    uint curThread = GetCurrentThreadId();
    GetWindowThreadProcessId(hWnd, out targetPid);
    bool attached = false;
    if (fgThread != 0 && fgThread != curThread) {
      attached = AttachThreadInput(curThread, fgThread, true);
    }
    try {
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(curThread, fgThread, false);
    }
    return GetForegroundWindow() == hWnd;
  }

  public static int[] ShowWindows(uint pid, bool focus, string classFilter) {
    List<IntPtr> wins = FindTargetWindows(pid, classFilter);
    int count = 0;
    IntPtr primary = IntPtr.Zero;
    foreach (IntPtr h in wins) {
      if (primary == IntPtr.Zero) primary = h;
      if (GetPropW(h, PROP_STEALTH) != IntPtr.Zero) {
        bool hasRect = GetPropW(h, PROP_HAS_RECT).ToInt32() == 1;
        int rx = GetPropW(h, PROP_X).ToInt32();
        int ry = GetPropW(h, PROP_Y).ToInt32();
        int rw = GetPropW(h, PROP_W).ToInt32();
        int rh = GetPropW(h, PROP_H).ToInt32();
        bool wasMax = GetPropW(h, PROP_MAX).ToInt32() == 1;
        long origEx = GetPropW(h, PROP_EX).ToInt64();

        if (!hasRect || rw < 200 || rh < 150 || rx <= -10000 || ry <= -10000) {
          RECT defRect = DefaultCenteredRect(rw >= 200 ? rw : 1280, rh >= 150 ? rh : 850);
          rx = defRect.Left;
          ry = defRect.Top;
          rw = defRect.Right - defRect.Left;
          rh = defRect.Bottom - defRect.Top;
        }

        long restoredEx = origEx & ~(WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE);
        RemovePropW(h, PROP_STEALTH);
        RemovePropW(h, PROP_HAS_RECT);
        RemovePropW(h, PROP_X);
        RemovePropW(h, PROP_Y);
        RemovePropW(h, PROP_W);
        RemovePropW(h, PROP_H);
        RemovePropW(h, PROP_MAX);
        RemovePropW(h, PROP_EX);

        ShowWindow(h, SW_HIDE);
        SetExStyle(h, restoredEx);
        SetWindowPos(h, IntPtr.Zero, rx, ry, rw, rh, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        ShowWindow(h, wasMax ? SW_SHOWMAXIMIZED : (focus ? SW_SHOWNORMAL : SW_SHOW));
      } else if (IsIconic(h) && focus) {
        ShowWindow(h, SW_RESTORE);
      }
      count++;
    }
    int focused = 0;
    if (focus && primary != IntPtr.Zero) {
      focused = ForceForeground(primary) ? 1 : 0;
    }
    return new int[] { count, focused };
  }
}
'@

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $reqId = 0
  try {
    $cmd = $line | ConvertFrom-Json
    $reqId = $cmd.id
    $op = [string]$cmd.op
    $cls = if ($cmd.windowClass) { [string]$cmd.windowClass } else { 'Chrome_WidgetWin_1' }
    if ($op -eq 'status') {
      $tPid = if ($cmd.targetPid) { [uint32]$cmd.targetPid } else { [uint32]0 }
      $st = [MaBrowserStealthWin32]::GetStatus($tPid, $cls)
      $resp = @{ id = $reqId; ok = $true; trayRunning = [MaBrowserStealthWin32]::IsTrayRunning(); windowCount = $st[0]; stealth = ($st[1] -eq 1) }
    } elseif ($op -eq 'hide') {
      $n = [MaBrowserStealthWin32]::HideWindows([uint32]$cmd.targetPid, $cls)
      $resp = @{ id = $reqId; ok = $true; trayRunning = [MaBrowserStealthWin32]::IsTrayRunning(); affectedCount = $n }
    } elseif ($op -eq 'show') {
      $res = [MaBrowserStealthWin32]::ShowWindows([uint32]$cmd.targetPid, [bool]$cmd.focus, $cls)
      $resp = @{ id = $reqId; ok = $true; trayRunning = [MaBrowserStealthWin32]::IsTrayRunning(); affectedCount = $res[0]; focused = ($res[1] -eq 1) }
    } elseif ($op -eq 'findPid') {
      $port = [int]$cmd.port
      $prof = ([string]$cmd.profileDir).Replace('\', '/').ToLowerInvariant()
      $proc = Get-CimInstance Win32_Process -Filter "CommandLine like '%--remote-debugging-port=$port%'" | Where-Object {
        $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=' -and
        $_.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($prof)
      } | Select-Object -First 1
      $foundPid = if ($proc) { [int]$proc.ProcessId } else { $null }
      $resp = @{ id = $reqId; ok = $true; pid = $foundPid }
    } elseif ($op -eq 'findBrowserProcess') {
      $port = [int]$cmd.port
      $procs = @(Get-CimInstance Win32_Process -Filter "CommandLine like '%--remote-debugging-port=$port%'" | Where-Object {
        $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type='
      } | ForEach-Object { @{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } })
      $resp = @{ id = $reqId; ok = $true; procs = $procs }
    } else {
      throw "Unknown op: $op"
    }
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } catch {
    $errResp = @{ id = $reqId; ok = $false; error = $_.Exception.Message }
    [Console]::Out.WriteLine(($errResp | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  }
}
`;

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Resident Win32 window controller backed by a single lazy-spawned PowerShell
 * worker. First call compiles the P/Invoke helper once (~400ms); every call
 * after that executes in ~2ms over stdio.
 */
export class WindowsWindowController implements WindowModeDriver {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private readyPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();

  private ensureWorker(): Promise<void> {
    if (process.platform !== "win32") {
      return Promise.reject(new Error("WindowsWindowController is only supported on Windows"));
    }
    if (this.readyPromise && this.child && this.child.exitCode === null) {
      return this.readyPromise;
    }

    this.close();

    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      // Bootstrap the worker script over stdin (one base64 line) so the command
      // line stays ~120 chars and never approaches Windows' 32 KB limit.
      const bootstrap = "$b=[Console]::In.ReadLine(); if($b){Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)))}";
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", bootstrap],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      child.stdin.write(`${Buffer.from(PS_WORKER_SCRIPT, "utf8").toString("base64")}\n`);
      child.unref();
      (child.stdin as unknown as { unref?: () => void }).unref?.();
      (child.stdout as unknown as { unref?: () => void }).unref?.();
      (child.stderr as unknown as { unref?: () => void }).unref?.();

      this.child = child;
      let stderrText = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrText += chunk.toString("utf8");
      });

      let initialized = false;
      const startupTimer = setTimeout(() => {
        if (!initialized) {
          this.close();
          rejectReady(new Error(`Win32 window helper timed out starting up${stderrText ? `: ${stderrText.trim()}` : ""}`));
        }
      }, 15_000);

      const rl = createInterface({ input: child.stdout });
      this.rl = rl;

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!initialized && msg.ready === true) {
          initialized = true;
          clearTimeout(startupTimer);
          resolveReady();
          return;
        }
        const id = typeof msg.id === "number" ? msg.id : 0;
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        if (msg.ok === false) {
          waiter.reject(new Error(String(msg.error ?? "Win32 window operation failed")));
        } else {
          waiter.resolve(msg);
        }
      });

      const onExit = () => {
        clearTimeout(startupTimer);
        const err = new Error(
          `Win32 window helper exited unexpectedly${stderrText ? `: ${stderrText.trim()}` : ""}`,
        );
        if (!initialized) {
          rejectReady(err);
        }
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        this.child = null;
        this.rl = null;
        this.readyPromise = null;
      };

      child.once("error", onExit);
      child.once("exit", onExit);
    });

    return this.readyPromise;
  }

  private async request(payload: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    await this.ensureWorker();
    const child = this.child;
    if (!child || child.exitCode !== null) {
      throw new Error("Win32 window helper is not running");
    }
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // Keep timer referenced while a request is actively awaited (Node 22+ test runner rule).
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Win32 window command "${String(payload.op)}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  async status(pid?: number | null, windowClass = "Chrome_WidgetWin_1"): Promise<WindowModeStatusResult> {
    if (process.platform !== "win32") {
      return { trayRunning: false, windowCount: 0, stealth: false };
    }
    const res = await this.request({ op: "status", targetPid: pid ?? 0, windowClass });
    return {
      trayRunning: Boolean(res.trayRunning),
      windowCount: Number(res.windowCount ?? 0),
      stealth: Boolean(res.stealth),
    };
  }

  async hide(pid: number, windowClass = "Chrome_WidgetWin_1"): Promise<WindowModeApplyResult> {
    const res = await this.request({ op: "hide", targetPid: pid, windowClass });
    return {
      trayRunning: Boolean(res.trayRunning),
      affectedCount: Number(res.affectedCount ?? 0),
    };
  }

  async show(pid: number, focus = false, windowClass = "Chrome_WidgetWin_1"): Promise<WindowModeApplyResult> {
    const res = await this.request({ op: "show", targetPid: pid, focus, windowClass });
    return {
      trayRunning: Boolean(res.trayRunning),
      affectedCount: Number(res.affectedCount ?? 0),
      focused: Boolean(res.focused),
    };
  }

  async findBrowserProcess(port: number): Promise<BrowserProcessMatch | null> {
    if (process.platform !== "win32") return null;
    const res = await this.request({ op: "findBrowserProcess", port }, 10_000);
    const procs = Array.isArray(res.procs)
      ? res.procs
      : (res.procs && typeof res.procs === "object" ? [res.procs] : []);
    for (const item of procs) {
      if (!item || typeof item !== "object") continue;
      const pid = Number((item as { pid?: unknown }).pid);
      const commandLine = String((item as { commandLine?: unknown }).commandLine ?? "");
      if (!Number.isInteger(pid) || pid <= 0 || !commandLine) continue;
      const hint = hintFromArgs(splitCommandLine(commandLine), pid);
      if (hint && hint.port === port) {
        return { pid: hint.pid, userDataDir: hint.userDataDir };
      }
    }
    return null;
  }

  async findManagedPid(port: number, profileDir: string): Promise<number | null> {
    if (process.platform !== "win32") return null;
    const res = await this.request({ op: "findPid", port, profileDir }, 10_000);
    const pid = Number(res.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Win32 window helper closed"));
    }
    this.pending.clear();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {}
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.readyPromise = null;
  }
}

/** Shared singleton controller for Windows stealth operations. */
export const windowsStealth = new WindowsWindowController();
