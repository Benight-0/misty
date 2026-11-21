using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Misty.Overlay;

internal sealed class SshBridge : IDisposable
{
    private readonly string root;
    private readonly SemaphoreSlim gate = new(1, 1);
    private Process? process;
    private long sequence;

    internal SshBridge(string root) => this.root = root;

    internal static string FindRoot()
    {
        var configured = Environment.GetEnvironmentVariable("MISTY_ROOT");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(Path.Combine(configured, "data", "deployment", "ssh_config")))
            return configured;
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "data", "deployment", "ssh_config")))
                return dir.FullName;
        throw new FileNotFoundException("Misty's paired SSH configuration was not found. Install from the misty folder.");
    }

    private void Start()
    {
        if (process is { HasExited: false }) return;
        process?.Dispose();
        var start = new ProcessStartInfo("ssh.exe")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false)
        };
        foreach (var arg in new[] {
            "-T", "-F", Path.Combine(root, "data", "deployment", "ssh_config"),
            "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "IPQoS=none",
            "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=3",
            "archival-vm", "sudo", "runuser", "-u", "misty-bot", "--", "env",
            "PROMINENCE_CONFIG=/etc/misty-prominence/config.json",
            "/opt/misty-prominence/venv/bin/python", "/opt/misty-prominence/overlay_agent.py"
        }) start.ArgumentList.Add(arg);
        process = Process.Start(start) ?? throw new IOException("Could not start the paired SSH bridge.");
        // Drain stderr so a long running connection cannot block on a full pipe.
        process.ErrorDataReceived += (_, _) => { };
        process.BeginErrorReadLine();
    }

    internal async Task<JsonElement> RequestAsync(object request, CancellationToken cancellation = default)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(75));
        try { await gate.WaitAsync(deadline.Token); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            throw new TimeoutException("The Misty bridge timed out while waiting for another request. Refresh before retrying the action.");
        }
        try
        {
            Start();
            var id = Interlocked.Increment(ref sequence);
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(request));
            var payload = new Dictionary<string, object?> { ["id"] = id };
            foreach (var property in document.RootElement.EnumerateObject())
                payload[property.Name] = property.Value;
            await process!.StandardInput.WriteLineAsync(JsonSerializer.Serialize(payload).AsMemory(), deadline.Token);
            await process.StandardInput.FlushAsync(deadline.Token);
            var line = await process.StandardOutput.ReadLineAsync(deadline.Token);
            if (line == null) throw new IOException("The Misty bridge disconnected.");
            using var response = JsonDocument.Parse(line);
            if (!response.RootElement.TryGetProperty("id", out var returned) || returned.GetInt64() != id)
                throw new IOException("The Misty bridge returned an unexpected response.");
            if (response.RootElement.TryGetProperty("error", out var error))
                throw new InvalidOperationException(error.GetString() ?? "Misty rejected the request.");
            return response.RootElement.GetProperty("result").Clone();
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            Reset();
            throw new TimeoutException("The Misty bridge timed out. Refresh before retrying the action.");
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or JsonException)
        {
            Reset();
            throw;
        }
        finally { gate.Release(); }
    }

    private void Reset()
    {
        try { if (process is { HasExited: false }) process.Kill(entireProcessTree: true); } catch { }
        process?.Dispose();
        process = null;
    }

    public void Dispose()
    {
        Reset();
        gate.Dispose();
    }
}
