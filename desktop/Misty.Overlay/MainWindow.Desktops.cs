using System.IO;
using System.Windows.Interop;
using System.Windows.Threading;
using WindowsDesktop;

namespace Misty.Overlay;

public partial class MainWindow
{
    private DispatcherTimer? desktopPresenceTimer;
    private void StartDesktopPresence()
    {
        EnsureDesktopPresence();
        desktopPresenceTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(20) };
        desktopPresenceTimer.Tick += (_, _) => EnsureDesktopPresence();
        desktopPresenceTimer.Start();
    }

    // Pin this one window, keeping its panel, visibility and draft state intact.
    // Recheck after Explorer restarts; never activate a window or switch desktops.
    private void EnsureDesktopPresence()
    {
        try
        {
            var handle = new WindowInteropHelper(this).Handle;
            var pinned = VirtualDesktop.PinWindow(handle) && VirtualDesktop.IsPinnedWindow(handle);
            WriteDesktopPresence(pinned ? "pinned" : "waiting for window");
        }
        catch (Exception error)
        { WriteDesktopPresence("unavailable: " + error.GetType().Name + ": " + error.Message); }
    }

    private void WriteDesktopPresence(string state)
    {
        try { File.WriteAllText(Path.Combine(Path.GetDirectoryName(stateFile)!, "desktop-presence.txt"), state); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}