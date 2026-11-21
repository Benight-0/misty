using NAudio.Wave;
using Vosk;
using System.IO;
using System.Text.Json;
using System.Speech.Synthesis;
using System.Text.RegularExpressions;

namespace Misty.Overlay;

// Windows SAPI engines: all microphone processing and synthesis stay on this PC.
internal sealed class LocalVoice : IDisposable
{
    private readonly SpeechSynthesizer speaker = new();
    private Model? model;
    private VoskRecognizer? wakeRecognizer;
    private WaveInEvent? microphone;
    private readonly object audioLock = new();
    private readonly Queue<byte[]> preroll = new();
    private bool disposed, listening, speaking, wakeEnabled = true;
    private DateTime ignoreUntil;
    private readonly System.Threading.Timer timeout;
    private MemoryStream? capture;
    private bool captureFromWake, transcribing;
    private int speechSamples, quietSamples;
    private long generation;
    private CancellationTokenSource? recognitionCancel;
    private readonly Queue<string> deferredSpeech=new();
    internal RecognitionResult? LastRecognition { get; private set; }
    internal long RejectedWakeCount { get; private set; }
    internal event Action<string>? StateChanged;
    internal event Action<string>? Transcript;
    internal string Status { get; private set; } = "Starting local voice";
    internal bool InputAvailable => microphone != null && model != null;
    internal bool Listening => listening;
    internal string Engine { get; private set; } = "";
    internal string VoiceName => speaker.Voice.Name;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<Prompt,string> speechHashes=new();
    internal string CompletedSpeechHash {get;private set;}="";
    internal long CompletedSpeechCount {get;private set;}
    internal LocalVoice()
    {
        speaker.SetOutputToDefaultAudioDevice();
        var zira = speaker.GetInstalledVoices().FirstOrDefault(v => v.Enabled && v.VoiceInfo.Name.Contains("Zira"));
        if (zira != null) speaker.SelectVoice(zira.VoiceInfo.Name);
        speaker.SpeakStarted += (_, _) => { if(disposed)return; speaking = true; State("Speaking locally"); };
        speaker.SpeakCompleted += (_, e) =>
        {
            if(disposed)return;
            if(speechHashes.TryRemove(e.Prompt,out var hash)&&!e.Cancelled&&e.Error==null){CompletedSpeechHash=hash;CompletedSpeechCount++;}
            speaking=speaker.State==SynthesizerState.Speaking;ignoreUntil=DateTime.UtcNow.AddMilliseconds(650);
            if(!speaking)State(listening?"Listening for your request":wakeEnabled?"Wake word: Misty":"Wake word off");
        };
        timeout=new(_=>FinishCapture(),null,Timeout.Infinite,Timeout.Infinite);
    }
    internal static string ModelPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Misty", "Voice", "vosk-model-small-en-us-0.15");
    internal void Start()
    {
        try
        {
            Vosk.Vosk.SetLogLevel(-1);
            model=new Model(ModelPath);
            Engine="Whisper base.en Q5_1, 2 CPU threads; Vosk wake candidate, Whisper verified";
            wakeRecognizer=new VoskRecognizer(model,16000f,"[\"misty\",\"hey misty\",\"[unk]\"]");
            microphone=new WaveInEvent{DeviceNumber=-1,WaveFormat=new WaveFormat(16000,16,1),BufferMilliseconds=100,NumberOfBuffers=3};
            microphone.DataAvailable+=(_,e)=>{try{ProcessAudio(e.Buffer,e.BytesRecorded);}catch(Exception error){State("Local audio: "+error.Message);}};
            microphone.RecordingStopped+=(_,e)=>{if(e.Exception!=null)State("Microphone unavailable: "+e.Exception.Message);};
            microphone.StartRecording();State("Wake word: Misty");
        }
        catch(Exception error){microphone?.Dispose();microphone=null;State("Local microphone unavailable: "+error.Message);}
    }
    private static string JsonText(string json,string key)
    {
        using var doc=JsonDocument.Parse(json);
        return doc.RootElement.TryGetProperty(key,out var value)?value.GetString()??"":"";
    }
    private static double Rms(byte[] bytes,int count)
    {
        double sum=0;for(var i=0;i+1<count;i+=2){var value=BitConverter.ToInt16(bytes,i);sum+=(double)value*value;}
        return count>1?Math.Sqrt(sum/(count/2)):0;
    }
    private void AppendAudio(byte[] bytes,int count)
    {
        capture?.Write(bytes,0,count);
        if(Rms(bytes,count)>=150){speechSamples+=count/2;quietSamples=0;}else quietSamples+=count/2;
    }
    private void ProcessAudio(byte[] buffer,int count)
    {
        var finish=false;
        lock(audioLock)
        {
            if(disposed||speaking||DateTime.UtcNow<ignoreUntil||wakeRecognizer==null||transcribing)return;
            if(listening)
            {
                AppendAudio(buffer,count);
                finish=(speechSamples>=4000&&quietSamples>=22400)||(capture?.Length??0)>=20*32000;
            }
            else if(wakeEnabled)
            {
                preroll.Enqueue(buffer.Take(count).ToArray());while(preroll.Count>16)preroll.Dequeue();
                var final=wakeRecognizer.AcceptWaveform(buffer,count);
                var heard=JsonText(final?wakeRecognizer.Result():wakeRecognizer.PartialResult(),final?"text":"partial");
                if(Regex.IsMatch(heard,@"\bmisty\b",RegexOptions.IgnoreCase))
                {
                    BeginListening(true);
                    foreach(var part in preroll)AppendAudio(part,part.Length);
                    preroll.Clear();
                }
            }
        }
        if(finish)FinishCapture();
    }
    private void State(string value){if(disposed)return;Status=value;StateChanged?.Invoke(value);}
    internal void SetWake(bool enabled)
    {
        wakeEnabled=enabled;if(!InputAvailable)return;if(!enabled)EndListening();
        lock(audioLock){wakeRecognizer?.Reset();preroll.Clear();}
        State(enabled?"Wake word: Misty (verified locally)":"Wake word off; Ctrl+Shift+V still works");
    }
    internal void ToggleListening(){if(listening)FinishCapture();else BeginListening();}
    private void BeginListening(bool fromWake=false)
    {
        if(disposed||!InputAvailable){State("No offline microphone available");return;}
        lock(audioLock)
        {
            recognitionCancel?.Cancel();generation++;transcribing=false;
            speaker.SpeakAsyncCancelAll();speaking=false;ignoreUntil=DateTime.UtcNow.AddMilliseconds(fromWake?0:250);
            capture?.Dispose();capture=new MemoryStream();captureFromWake=fromWake;speechSamples=quietSamples=0;listening=true;
            timeout.Change(20000,Timeout.Infinite);
        }
        State("Listening locally; waiting for a complete request");
    }
    internal void EndListening()
    {
        if(disposed)return;
        lock(audioLock)
        {
            generation++;recognitionCancel?.Cancel();transcribing=false;listening=false;
            timeout.Change(Timeout.Infinite,Timeout.Infinite);capture?.Dispose();capture=null;wakeRecognizer?.Reset();preroll.Clear();
        }
        State(wakeEnabled?"Wake word: Misty":"Wake word off");
    }
    private void FinishCapture()
    {
        byte[] bytes;bool fromWake;long id;CancellationToken token;
        lock(audioLock)
        {
            if(disposed||!listening)return;
            listening=false;timeout.Change(Timeout.Infinite,Timeout.Infinite);
            bytes=capture?.ToArray()??[];capture?.Dispose();capture=null;fromWake=captureFromWake;id=generation;
            if(speechSamples<4000||bytes.Length<11200){wakeRecognizer?.Reset();State("No clear speech; request discarded");return;}
            transcribing=true;recognitionCancel?.Dispose();recognitionCancel=new CancellationTokenSource(TimeSpan.FromSeconds(25));token=recognitionCancel.Token;
        }
        State("Transcribing locally with Whisper");
        _=Task.Run(async()=>
        {
            try
            {
                var result=await WhisperTranscriber.RecognizeAsync(bytes,token);
                lock(audioLock){if(disposed||generation!=id)return;LastRecognition=result;transcribing=false;wakeRecognizer?.Reset();preroll.Clear();ignoreUntil=DateTime.UtcNow.AddMilliseconds(1000);}
                var validWake=!fromWake||WhisperTranscriber.ContainsWake(result.Text);
                var command=WhisperTranscriber.Command(result.Text,fromWake);
                if(!validWake||result.Confidence<.45){if(fromWake)RejectedWakeCount++;State("Unverified wake or unclear speech ignored");}
                else if(command.Length==0&&fromWake){BeginListening();System.Media.SystemSounds.Asterisk.Play();}
                else if(command.Length>0){State("Recognised request ready");Transcript?.Invoke(command);}
                else State("No clear request recognised");
            }
            catch(OperationCanceledException){lock(audioLock){if(generation==id){transcribing=false;State("Recognition cancelled");}}}
            catch(Exception error){lock(audioLock){if(generation==id){transcribing=false;State("Local recognition failed: "+error.Message);}}}
            finally
            {
                Array.Clear(bytes);
                string[] waiting;
                lock(audioLock){waiting=!disposed&&!listening&&!transcribing?deferredSpeech.ToArray():[];if(waiting.Length>0)deferredSpeech.Clear();}
                foreach(var text in waiting)Speak(text);
            }
        });
    }    internal static string SpokenText(string text)
    {
        text = Regex.Replace(text, @"```[\s\S]*?```", " code shown in chat ");
        text = Regex.Replace(text, @"\[([^\]]+)\]\([^\)]+\)", "$1");
        text = Regex.Replace(text, @"https?://\S+", " link in chat ");
        text = Regex.Replace(text, @"[*_`#>]+", "");
        return text.Trim();
    }
    internal void Speak(string text)
    {
        if (disposed) return;
        text = SpokenText(text);
        if (text.Length == 0) return;
        lock(audioLock){if(listening||transcribing){deferredSpeech.Enqueue(text);return;}}
        speaking = true;
        try
        {
            var prompt=new Prompt(text);speechHashes[prompt]=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text)));
            speaker.SpeakAsync(prompt);
        }
        catch (Exception error) { speaking = false; State("Voice output: " + error.Message); }
    }
    internal void StopSpeaking() { lock(audioLock)deferredSpeech.Clear(); speaker.SpeakAsyncCancelAll(); speaking = false; }
    public void Dispose()
    {
        disposed = true; timeout.Dispose();
        recognitionCancel?.Cancel();
        microphone?.StopRecording(); microphone?.Dispose();
        lock(audioLock) { wakeRecognizer?.Dispose(); model?.Dispose(); capture?.Dispose(); }
        speaker.SpeakAsyncCancelAll(); speaker.Dispose();
    }
}