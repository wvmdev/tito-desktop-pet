// tito-windows.exe: streams what Tito needs to know about the desktop, one JSON value per line.
//   - every interval: the visible app windows, front to back, as an array of {id,pid,x,y,w,h}
//     (physical pixels). Bounds only: no titles or contents are sent anywhere.
//   - {"audio":true|false} when sound is playing / stops (the default output's peak meter, no capture)
//   - {"battery":{"percent":N,"charging":true|false}} or {"battery":null} once a minute
// Usage: tito-windows.exe <ownPid> [intervalMs] [parentPid]
// Plain C# 5 so it builds with any compiler (Mono's mcs on a Mac, csc on Windows).
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Native
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct SYSTEM_POWER_STATUS { public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag; public int BatteryLifeTime, BatteryFullLifeTime; }

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
    [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation
{
    [PreserveSig] int GetPeakValue(out float peak);
}

static class Audio
{
    static IAudioMeterInformation meter;
    static DateTime openedAt = DateTime.MinValue;

    public static bool Playing()
    {
        try
        {
            if (meter == null || (DateTime.UtcNow - openedAt).TotalSeconds > 60) Open(); // follow a changed default device
            float peak;
            if (meter.GetPeakValue(out peak) != 0) { meter = null; return false; }
            return peak > 0.002f;
        }
        catch (Exception) { meter = null; return false; }
    }

    static void Open()
    {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) throw new InvalidOperationException("no output device");
        Guid iid = typeof(IAudioMeterInformation).GUID;
        object o;
        if (device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) throw new InvalidOperationException("no meter");
        meter = (IAudioMeterInformation)o;
        openedAt = DateTime.UtcNow;
    }
}

static class Program
{
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080, WS_EX_LAYERED = 0x00080000, WS_EX_NOACTIVATE = 0x08000000;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

    // Windows that exist but are not something Tito can stand on.
    static readonly string[] SkipClasses = {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow",
        "XamlExplorerHostIslandWindow", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland",
    };

    static string Snapshot(int ownPid)
    {
        StringBuilder sb = new StringBuilder("[");
        bool first = true;
        StringBuilder cls = new StringBuilder(256);
        Native.EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            try
            {
                if (!Native.IsWindowVisible(h) || Native.IsIconic(h)) return true;
                int cloaked;
                if (Native.DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true; // other virtual desktop / hidden UWP
                int ex = Native.GetWindowLong(h, GWL_EXSTYLE);
                if ((ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) != 0) return true;
                if ((ex & WS_EX_LAYERED) != 0)
                {
                    uint key, flags; byte alpha;
                    if (Native.GetLayeredWindowAttributes(h, out key, out alpha, out flags) && (flags & 2) != 0 && alpha < 50) return true; // nearly invisible overlay
                }
                if (Native.GetWindowTextLength(h) == 0) return true;
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                if ((int)pid == ownPid) return true;
                cls.Length = 0;
                Native.GetClassName(h, cls, 256);
                string c = cls.ToString();
                for (int i = 0; i < SkipClasses.Length; i++) if (c == SkipClasses[i]) return true;
                Native.RECT r;
                if (Native.DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, 16) != 0 && !Native.GetWindowRect(h, out r)) return true;
                int w = r.Right - r.Left, hh = r.Bottom - r.Top;
                if (w < 120 || hh < 60) return true;
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"id\":").Append(h.ToInt64()).Append(",\"pid\":").Append(pid)
                  .Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
                  .Append(",\"w\":").Append(w).Append(",\"h\":").Append(hh).Append('}');
            }
            catch (Exception) { }
            return true;
        }, IntPtr.Zero);
        return sb.Append(']').ToString();
    }

    static string Battery()
    {
        Native.SYSTEM_POWER_STATUS s;
        if (!Native.GetSystemPowerStatus(out s) || s.BatteryFlag == 128 || s.BatteryLifePercent > 100) return "{\"battery\":null}";
        return "{\"battery\":{\"percent\":" + s.BatteryLifePercent + ",\"charging\":" + (s.ACLineStatus == 1 ? "true" : "false") + "}}";
    }

    static void Main(string[] args)
    {
        int ownPid = args.Length > 0 ? int.Parse(args[0]) : 0;
        int interval = args.Length > 1 ? Math.Max(100, int.Parse(args[1])) : 250;
        int parentPid = args.Length > 2 ? int.Parse(args[2]) : 0;
        try { if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) Native.SetProcessDPIAware(); } // physical pixels, per monitor
        catch (Exception) { try { Native.SetProcessDPIAware(); } catch (Exception) { } }

        Process parent = null;
        if (parentPid > 0) { try { parent = Process.GetProcessById(parentPid); } catch (Exception) { return; } } // already gone
        StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        output.NewLine = "\n";

        Stopwatch clock = Stopwatch.StartNew();
        long nextAudio = 0, nextBattery = 0, audioSentAt = -100000;
        bool lastAudio = false, audioKnown = false;
        while (true)
        {
            try
            {
                if (parent != null && parent.HasExited) return; // Tito quit: do not linger
                output.WriteLine(Snapshot(ownPid));
                long now = clock.ElapsedMilliseconds;
                if (now >= nextAudio)
                {
                    nextAudio = now + 3000;
                    bool a = Audio.Playing();
                    if (!audioKnown || a != lastAudio || now - audioSentAt > 15000) { output.WriteLine("{\"audio\":" + (a ? "true" : "false") + "}"); audioSentAt = now; }
                    lastAudio = a; audioKnown = true;
                }
                if (now >= nextBattery) { nextBattery = now + 60000; output.WriteLine(Battery()); }
            }
            catch (IOException) { return; }      // the pipe closed: Tito is gone
            catch (Exception) { }                // never die over one bad frame
            Thread.Sleep(interval);
        }
    }
}
