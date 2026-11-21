using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace Misty.Overlay;

public partial class MainWindow
{
    private LocalVoice? localVoice;
    private bool speakReplies = true, wakeWord = true, voiceReady;
    private readonly DateTimeOffset voiceStarted = DateTimeOffset.UtcNow;
    private readonly HashSet<int> extraHotkeys = new();
    private DispatcherTimer? uiPersistenceTimer;
    private string lastUiState = "", lastSpokenText = "";
    private readonly HashSet<string> spokenMessageIds=new();
    private string UiStatePath => Path.Combine(Path.GetDirectoryName(stateFile)!, "workspace.json");
    private string VoiceStatusPath => Path.Combine(Path.GetDirectoryName(stateFile)!, "voice-status.json");
    private readonly (Key Key, string Tab)[] panelKeys = [(Key.Z,"chat"),(Key.Q,"codex"),
        (Key.A,"activity"),(Key.C,"vm"),(Key.D,"gmail"),(Key.F,"approvals")];

    private void InitializeVoiceMenu(Forms.ContextMenuStrip menu)
    {
        var listen = menu.Items.Add("Talk to Misty · Ctrl+Shift+V");
        listen.Click += (_, _) => Dispatcher.Invoke(() => localVoice?.ToggleListening());
        var output = new Forms.ToolStripMenuItem("Speak new Misty replies") { Checked = speakReplies, CheckOnClick = true };
        output.CheckedChanged += (_, _) => Dispatcher.Invoke(() =>
        { speakReplies = output.Checked; if (!speakReplies) localVoice?.StopSpeaking(); SaveWorkspace(); });
        menu.Items.Add(output);
        var wakeToggle = new Forms.ToolStripMenuItem("Listen for Misty locally") { Checked = wakeWord, CheckOnClick = true };
        wakeToggle.CheckedChanged += (_, _) => Dispatcher.Invoke(() =>
        { wakeWord = wakeToggle.Checked; localVoice?.SetWake(wakeWord); SaveWorkspace(); });
        menu.Items.Add(wakeToggle);
        menu.Items.Add("Stop speech · Ctrl+Shift+S", null, (_, _) => Dispatcher.Invoke(() => localVoice?.StopSpeaking()));
        menu.Items.Add("Repeat last spoken reply", null, (_, _) => Dispatcher.Invoke(() => localVoice?.Speak(lastSpokenText)));
        menu.Items.Add("Tabs: Ctrl+Shift+Z chat · Q Codex · A activity · C VM · D Gmail · F approvals").Enabled = false;
    }
    private void RegisterVoiceHotkeys()
    {
        if (windowSource == null) return;
        void Register(int id, Key key)
        {
            if (RegisterHotKey(windowSource.Handle,id,ModControl|ModShift|0x4000,(uint)KeyInterop.VirtualKeyFromKey(key))) extraHotkeys.Add(id);
            else WriteVoiceStatus("Shortcut unavailable: Ctrl+Shift+"+key);
        }
        Register(0x4D60,Key.V); Register(0x4D61,Key.S);
        for (var i=0;i<panelKeys.Length;i++) Register(0x4D70+i,panelKeys[i].Key);
        TalkButton.ToolTip="Talk · Ctrl+Shift+Z"; CodexButton.ToolTip="Codex · Ctrl+Shift+Q";
        ActivityButton.ToolTip="Activity · Ctrl+Shift+A"; VmButton.ToolTip="VM · Ctrl+Shift+C";
        GmailButton.ToolTip="Gmail · Ctrl+Shift+D"; ApprovalButton.ToolTip="Approvals · Ctrl+Shift+F";
    }
    private bool HandleVoiceHotkey(int id)
    {
        if (!extraHotkeys.Contains(id)) return false;
        if (id==0x4D60) { localVoice?.ToggleListening(); return true; }
        if (id==0x4D61) { localVoice?.StopSpeaking(); return true; }
        var index=id-0x4D70;
        if (index<0||index>=panelKeys.Length) return false;
        var panel=panelKeys[index].Tab;
        if (IsVisible && selected==panel) CollapsePanel();
        else { Show(); Activate(); ShowPanel(panel); }
        SaveWorkspace(); return true;
    }
    private void StartLocalVoice()
    {
        try
        {
            localVoice=new LocalVoice();
            localVoice.StateChanged += status => Dispatcher.BeginInvoke(() =>
            { WriteVoiceStatus(status); if (localVoice?.Listening==true) SetComposerStatus(status); });
            localVoice.Transcript += text => Dispatcher.BeginInvoke(async () => await SendVoiceAsync(text));
            localVoice.Start(); localVoice.SetWake(wakeWord);
            voiceReady=true;
            _=PollLocalSpeechAsync();
        }
        catch(Exception error) { WriteVoiceStatus("Voice unavailable: "+error.Message); }
        uiPersistenceTimer=new DispatcherTimer { Interval=TimeSpan.FromSeconds(1) };
        uiPersistenceTimer.Tick+=(_,_)=>SaveWorkspace(); uiPersistenceTimer.Start();
    }
    private async Task SendVoiceAsync(string text)
    {
        // A voice utterance is a normal owner input to the existing VM backend.
        // Its request ID is never reused for another utterance or blindly retried.
        var id=Guid.NewGuid().ToString("D");
        try
        {
            WriteVoiceStatus("Sending recognised request to Misty");
            using var inputBridge=new SshBridge(SshBridge.FindRoot());
            var result=await inputBridge.RequestAsync(new {op="send",clientId=id,text},stopping.Token);
            if(!Flag(result,"accepted")) throw new IOException("Request not accepted");
            WriteVoiceStatus("Request accepted; waiting for Misty");
        }
        catch(Exception)
        {
            // Preserve it visibly without auto-resubmission after unknown delivery.
            ShowFromTray(); ShowPanel("chat");
            Composer.Text=(Composer.Text.Length>0?Composer.Text+Environment.NewLine:"")+text;
            SetComposerStatus("Voice delivery unconfirmed. Check chat before sending this preserved transcript.");
        }
    }
    private void SpeakNewMessages(JsonElement response)
    {
        if (!voiceReady || !speakReplies || localVoice==null) return;
        foreach(var row in response.GetProperty("messages").EnumerateArray())
        {
            if(Value(row,"role")!="misty" || !spokenMessageIds.Add(Value(row,"id"))) continue;
            var at=Number(row,"at");
            if(at<voiceStarted.ToUnixTimeMilliseconds() || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-at>90000) continue;
            var body=Value(row,"body");
            if(body.StartsWith("Draft:")||body.StartsWith("Exact ")||body.StartsWith("End of ")) continue;
            lastSpokenText=body; localVoice.Speak(body);
        }
    }
    private void WriteVoiceStatus(string status)
    {
        try { File.WriteAllText(VoiceStatusPath,JsonSerializer.Serialize(new {at=DateTimeOffset.UtcNow,
            status,inputAvailable=localVoice?.InputAvailable??false,engine=localVoice?.Engine,
            completedSpeechHash=localVoice?.CompletedSpeechHash,completedSpeechCount=localVoice?.CompletedSpeechCount,
            lastRecognition=localVoice?.LastRecognition is {} rec ? new {rec.Model,rec.Confidence,rec.AudioSeconds,rec.Milliseconds,rec.CpuSeconds,rec.MachineCpuPercent,rec.PeakWorkingSetMB}:null,
            rejectedWakeCount=localVoice?.RejectedWakeCount,
            voice=localVoice?.VoiceName,speakReplies,wakeWord,hotkeys=extraHotkeys.Order().ToArray(),
            panelShortcuts=panelKeys.Select((p,i)=>new {tab=p.Tab,key="Ctrl+Shift+"+p.Key,registered=extraHotkeys.Contains(0x4D70+i)}).ToArray()})); }
        catch(IOException) { }
        if(tray!=null) tray.Text=("Misty · "+status)[..Math.Min(63,("Misty · "+status).Length)];
    }
    private void SaveWorkspace()
    {
        if(!IsLoaded) return;
        try
        {
            var body=JsonSerializer.Serialize(new {selected,Left,Top,Width,Height,Topmost,hidden=!IsVisible,
                composer=Composer.Text,codexDrafts,chatOffset=ChatScroll.VerticalOffset,
                codexOffset=CodexTranscriptScroll.VerticalOffset,speakReplies,wakeWord});
            if(body==lastUiState) return;
            var temp=UiStatePath+".tmp";File.WriteAllText(temp,body);File.Move(temp,UiStatePath,true);lastUiState=body;
        }
        catch(IOException) { }
    }
    private async Task PollLocalSpeechAsync()
    {
        using var speechBridge=new SshBridge(SshBridge.FindRoot());
        var cursor="";
        while(!stopping.IsCancellationRequested)
        {
            try
            {
                var response=await speechBridge.RequestAsync(new {op="messages",after=cursor},stopping.Token);
                SpeakNewMessages(response);
                foreach(var row in response.GetProperty("messages").EnumerateArray())
                {
                    var id=Value(row,"id");
                    if(ulong.TryParse(id,out var number)&&(cursor.Length==0||number>ulong.Parse(cursor)))cursor=id;
                }
            }
            catch(OperationCanceledException) when(stopping.IsCancellationRequested){break;}
            catch(Exception){ /* Separate audio polling never blocks local capture or the UI. */ }
            try { await Task.Delay(2000,stopping.Token); } catch(OperationCanceledException){break;}
        }
    }
    private void RestoreWorkspace()
    {
        try
        {
            if(!File.Exists(UiStatePath)) return;
            using var doc=JsonDocument.Parse(File.ReadAllText(UiStatePath)); var root=doc.RootElement;
            speakReplies=!root.TryGetProperty("speakReplies",out var sr)||sr.ValueKind!=JsonValueKind.False;
            wakeWord=!root.TryGetProperty("wakeWord",out var ww)||ww.ValueKind!=JsonValueKind.False;
            Composer.Text=Value(root,"composer");
            if(root.TryGetProperty("codexDrafts",out var drafts)&&drafts.ValueKind==JsonValueKind.Object)
                foreach(var item in drafts.EnumerateObject()) if(item.Value.ValueKind==JsonValueKind.String)codexDrafts[item.Name]=item.Value.GetString()??"";
            var panel=Value(root,"selected");
            if(panelKeys.Any(p=>p.Tab==panel)) ShowPanel(panel);
            var work=SystemParameters.WorkArea;
            Width=Decimal(root,"Width",Width,CompactWidth,Math.Max(CompactWidth,work.Width-16));
            Height=Decimal(root,"Height",Height,300,Math.Max(300,work.Height-16));
            PanelColumn.Width=new GridLength(selected.Length==0?0:Math.Max(0,Width-CompactWidth));
            Left=Decimal(root,"Left",Left,work.Left,Math.Max(work.Left,work.Right-Width));
            Top=Decimal(root,"Top",Top,work.Top,Math.Max(work.Top,work.Bottom-Height));
            if(root.TryGetProperty("Topmost",out var top))Topmost=top.ValueKind==JsonValueKind.True;
            var offset=Decimal(root,"chatOffset",0,0,1e9);
            _=Dispatcher.BeginInvoke(()=>ChatScroll.ScrollToVerticalOffset(offset),DispatcherPriority.Loaded);
            if(Flag(root,"hidden")) Hide();
        }
        catch(Exception error) when(error is IOException or JsonException or InvalidOperationException) { }
    }
    private void CloseLocalVoice()
    {
        SaveWorkspace(); uiPersistenceTimer?.Stop(); localVoice?.Dispose();
        if(windowSource!=null) foreach(var id in extraHotkeys)UnregisterHotKey(windowSource.Handle,id);
    }
}