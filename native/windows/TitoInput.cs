// tito-input.exe: posts mouse and keyboard input for Tito's computer-control tools (Windows).
//   tito-input check                       -> {"trusted":true}
//   tito-input click X Y [left|right] [N]  -> click at a point in physical screen pixels (N = click count)
//   tito-input scroll X Y DX DY            -> scroll at a point; DY < 0 scrolls the page down (pixels)
//   tito-input key COMBO                   -> e.g. "ctrl+shift+s", "return", "alt+f4", "win+d"
//   tito-input type                        -> types UTF-8 text read from stdin (kept off the command line)
// "cmd"/"command" mean Ctrl here, so a shortcut written the Mac way still does the right thing.
// Exit codes: 0 ok, 64 bad usage. Plain C# 5 so any compiler builds it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Native
{
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}

static class Program
{
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
    const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RETURN = 0x0D, VK_TAB = 0x09;

    static readonly Dictionary<string, ushort> Mods = new Dictionary<string, ushort> {
        { "ctrl", VK_CONTROL }, { "control", VK_CONTROL }, { "cmd", VK_CONTROL }, { "command", VK_CONTROL },
        { "shift", VK_SHIFT }, { "alt", VK_MENU }, { "option", VK_MENU },
        { "win", VK_LWIN }, { "windows", VK_LWIN }, { "super", VK_LWIN }, { "meta", VK_LWIN },
    };
    static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort> {
        { "return", VK_RETURN }, { "enter", VK_RETURN }, { "tab", VK_TAB }, { "space", 0x20 },
        { "backspace", 0x08 }, { "delete", 0x2E }, { "forwarddelete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D },
        { "escape", 0x1B }, { "esc", 0x1B },
        { "left", 0x25 }, { "up", 0x26 }, { "right", 0x27 }, { "down", 0x28 },
        { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
        { "printscreen", 0x2C }, { "capslock", 0x14 },
        { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 },
        { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B },
    };
    static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22, 0x2D, 0x2E, 0x5B };

    static void Fail(string msg, int code)
    {
        Console.Error.WriteLine(msg);
        Environment.Exit(code);
    }

    static double Num(string[] a, int i)
    {
        double v;
        if (a.Length <= i || !double.TryParse(a[i], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v)) Fail("bad number", 64);
        return a.Length > i ? double.Parse(a[i], System.Globalization.CultureInfo.InvariantCulture) : 0;
    }

    // "ctrl+shift+s" -> modifiers [ctrl, shift] + key VK. Used by `key` and by the dry-run test command.
    public static bool ParseCombo(string combo, List<ushort> mods, out ushort vk, out string error)
    {
        vk = 0; error = null;
        bool haveKey = false;
        string[] parts = combo.ToLowerInvariant().Split('+');
        for (int i = 0; i < parts.Length; i++)
        {
            string p = parts[i];
            if (p.Length == 0 && i == parts.Length - 1 && i > 0) p = "+"; // "ctrl++"
            ushort m, k;
            if (Mods.TryGetValue(p, out m)) { if (!mods.Contains(m)) mods.Add(m); }
            else if (Keys.TryGetValue(p, out k)) { vk = k; haveKey = true; }
            else if (p.Length == 1)
            {
                char c = p[0];
                if (c >= 'a' && c <= 'z') vk = (ushort)(0x41 + (c - 'a'));
                else if (c >= '0' && c <= '9') vk = (ushort)(0x30 + (c - '0'));
                else
                {
                    short scan = Native.VkKeyScan(c);
                    if (scan == -1) { error = "unknown key: " + p; return false; }
                    vk = (ushort)(scan & 0xFF);
                    if ((scan & 0x100) != 0 && !mods.Contains(VK_SHIFT)) mods.Add(VK_SHIFT);
                }
                haveKey = true;
            }
            else { error = "unknown key: " + p; return false; }
        }
        if (!haveKey) { error = "no key in combo"; return false; }
        return true;
    }

    static Native.INPUT Key(ushort vk, bool up)
    {
        Native.INPUT i = new Native.INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (Extended.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
        return i;
    }
    static Native.INPUT Unicode(ushort ch, bool up)
    {
        Native.INPUT i = new Native.INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wScan = ch;
        i.U.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        return i;
    }
    static Native.INPUT Mouse(uint flags, int data)
    {
        Native.INPUT i = new Native.INPUT();
        i.type = INPUT_MOUSE;
        i.U.mi.dwFlags = flags;
        i.U.mi.mouseData = unchecked((uint)data);
        return i;
    }
    static void Post(params Native.INPUT[] inputs)
    {
        uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
        if (sent != inputs.Length) Fail("input was blocked (is the target app running as administrator?)", 1);
    }

    static void Main(string[] args)
    {
        if (args.Length < 1) Fail("usage", 64);
        string cmd = args[0];
        if (cmd == "check") { Console.WriteLine("{\"trusted\":true}"); return; }
        if (cmd == "dry-key") // tests: show how a shortcut would be pressed, without sending anything
        {
            List<ushort> m = new List<ushort>(); ushort k; string err;
            if (args.Length < 2 || !ParseCombo(args[1], m, out k, out err)) { Console.WriteLine("error: " + (args.Length < 2 ? "usage" : "parse")); return; }
            Console.WriteLine("mods=" + string.Join(",", m.ConvertAll<string>(delegate(ushort x) { return "0x" + x.ToString("X2"); }).ToArray()) + " vk=0x" + k.ToString("X2"));
            return;
        }
        try { if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) Native.SetProcessDPIAware(); }
        catch (Exception) { try { Native.SetProcessDPIAware(); } catch (Exception) { } }

        switch (cmd)
        {
            case "click":
            {
                int x = (int)Math.Round(Num(args, 1)), y = (int)Math.Round(Num(args, 2));
                bool right = args.Length > 3 && args[3] == "right";
                int count = 1;
                if (args.Length > 4) { int.TryParse(args[4], out count); count = Math.Max(1, Math.Min(3, count)); }
                Native.SetCursorPos(x, y);
                Thread.Sleep(120);
                for (int n = 0; n < count; n++)
                {
                    Post(Mouse(right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN, 0));
                    Thread.Sleep(50);
                    Post(Mouse(right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP, 0));
                    Thread.Sleep(70);
                }
                break;
            }
            case "scroll":
            {
                int x = (int)Math.Round(Num(args, 1)), y = (int)Math.Round(Num(args, 2));
                double dx = Num(args, 3), dy = Num(args, 4);
                Native.SetCursorPos(x, y);
                Thread.Sleep(80);
                // A wheel notch is 120 units and scrolls roughly 100 pixels of page.
                int vy = (int)Math.Round(dy / 100.0 * 120.0), vx = (int)Math.Round(dx / 100.0 * 120.0);
                if (vy != 0) Post(Mouse(MOUSEEVENTF_WHEEL, vy));
                if (vx != 0) Post(Mouse(MOUSEEVENTF_HWHEEL, vx));
                break;
            }
            case "key":
            {
                if (args.Length < 2) Fail("usage", 64);
                List<ushort> mods = new List<ushort>(); ushort vk; string err;
                if (!ParseCombo(args[1], mods, out vk, out err)) Fail(err, 64);
                foreach (ushort m in mods) Post(Key(m, false));
                Post(Key(vk, false));
                Thread.Sleep(40);
                Post(Key(vk, true));
                for (int i = mods.Count - 1; i >= 0; i--) Post(Key(mods[i], true));
                break;
            }
            case "type":
            {
                string text;
                using (Stream stdin = Console.OpenStandardInput())
                using (StreamReader r = new StreamReader(stdin, new UTF8Encoding(false)))
                    text = r.ReadToEnd();
                foreach (char ch in text)
                {
                    if (ch == '\r') continue;
                    if (ch == '\n') { Post(Key(VK_RETURN, false), Key(VK_RETURN, true)); }
                    else if (ch == '\t') { Post(Key(VK_TAB, false), Key(VK_TAB, true)); }
                    else Post(Unicode(ch, false), Unicode(ch, true));
                    Thread.Sleep(5);
                }
                break;
            }
            default: Fail("unknown command", 64); break;
        }
        Thread.Sleep(60);
    }
}
