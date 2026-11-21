using System.Text.Json;
using System.Windows;
using System.Windows.Threading;

namespace Misty.Overlay;

public partial class MainWindow
{
    private JsonElement workingSnapshot;
    private DispatcherTimer? workingClock;

    private void InitializeWorkingClock()
    {
        workingClock = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        workingClock.Tick += (_, _) => RenderWorkingClock();
        workingClock.Start();
        Closed += (_, _) => workingClock.Stop();
    }

    private void RenderWorkingClock()
    {
        var text = WorkingDisplay.Render(workingSnapshot, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        WorkingText.Text = text;
        WorkingStrip.Visibility = text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }
}