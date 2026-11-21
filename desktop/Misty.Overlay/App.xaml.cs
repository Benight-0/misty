using System.Windows;

namespace Misty.Overlay;

public partial class App : System.Windows.Application
{
    private Mutex? instance;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        instance = new Mutex(true, "Local\\MistyOverlayOwnerDock", out var first);
        if (!first) { instance.Dispose(); instance = null; Shutdown(); return; }
        try
        {
            var window = new MainWindow();
            MainWindow = window;
            window.Show();
        }
        catch (Exception error)
        {
            System.Windows.MessageBox.Show(error.Message, "Misty could not start",
                MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (instance != null) { instance.ReleaseMutex(); instance.Dispose(); }
        base.OnExit(e);
    }
}
