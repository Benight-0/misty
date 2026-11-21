using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
using NAudio.Wave;
using Whisper.net;
using Vosk;

var root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Misty","Voice","benchmarks","20261109");
Directory.CreateDirectory(root);
if(args.Length>0 && args[0]=="devices")
{
    for(var i=0;i<WaveInEvent.DeviceCount;i++) Console.WriteLine(JsonSerializer.Serialize(new {index=i,name=WaveInEvent.GetCapabilities(i).ProductName}));
    using var devices=new NAudio.CoreAudioApi.MMDeviceEnumerator();
    using var device=devices.GetDefaultAudioEndpoint(NAudio.CoreAudioApi.DataFlow.Capture,NAudio.CoreAudioApi.Role.Communications);
    Console.WriteLine("Default communications capture: "+device.FriendlyName);
    return;
}
string[] Normalize(string text)=>Regex.Matches(text.ToLowerInvariant(),"[a-z0-9]+").Select(m=>m.Value).ToArray();
int Distance(string expected,string actual)
{
 var a=Normalize(expected);var b=Normalize(actual);var prev=Enumerable.Range(0,b.Length+1).ToArray();
 for(var i=1;i<=a.Length;i++){var cur=new int[b.Length+1];cur[0]=i;for(var j=1;j<=b.Length;j++)cur[j]=Math.Min(Math.Min(cur[j-1]+1,prev[j]+1),prev[j-1]+(a[i-1]==b[j-1]?0:1));prev=cur;}
 return prev[b.Length];
}
var fixturesPath=Path.Combine(root,"fixtures.json");
if(args.Length==0||args[0]=="fixtures")
{
 if(File.Exists(fixturesPath)){Console.WriteLine(fixturesPath);return;}
 var phrases=new[]{"Misty can you hear me now","Misty please open the financial aid checklist","Can you improve the speech recognition model while benchmarking memory and CPU usage","My Princeton financial aid application is due today","Turn wake listening on","I am going to school tomorrow morning"};
 var fixtures=new List<Fixture>();using var synth=new SpeechSynthesizer();
 foreach(var voice in new[]{"Microsoft Zira Desktop","Microsoft David Desktop"})
 foreach(var (phrase,i) in phrases.Select((p,i)=>(p,i)))
 {
  synth.SelectVoice(voice);synth.Rate=voice.Contains("David")?1:0;
  var path=Path.Combine(root,$"{(voice.Contains("Zira")?"zira":"david")}-{i}.wav");
  using(var pcm=new MemoryStream())
  {
   synth.SetOutputToAudioStream(pcm,new SpeechAudioFormatInfo(16000,AudioBitsPerSample.Sixteen,AudioChannel.Mono));synth.Speak(phrase);synth.SetOutputToNull();
   using var writer=new WaveFileWriter(path,new WaveFormat(16000,16,1));var data=pcm.ToArray();writer.Write(data,0,data.Length);writer.Write(new byte[32000],0,32000);
  }
  fixtures.Add(new(path,phrase,voice));
 }
 foreach(var name in new[]{"silence","quiet-noise"})
 {
  var path=Path.Combine(root,name+".wav");var data=new byte[96000];if(name=="quiet-noise"){var random=new Random(20261109);for(var i=0;i<data.Length;i+=2){var n=(short)random.Next(-100,101);data[i]=(byte)n;data[i+1]=(byte)(n>>8);}}
  using(var writer=new WaveFileWriter(path,new WaveFormat(16000,16,1)))writer.Write(data,0,data.Length);fixtures.Add(new(path,"",name));
 }
 File.WriteAllText(fixturesPath,JsonSerializer.Serialize(fixtures));Console.WriteLine(fixturesPath);return;
}
var modelName=args[0];var threads=args.Length>1?int.Parse(args[1]):2;
var fixturesToRun=JsonSerializer.Deserialize<List<Fixture>>(File.ReadAllText(fixturesPath))!;
var proc=Process.GetCurrentProcess();var startCpu=proc.TotalProcessorTime;var load=Stopwatch.StartNew();
WhisperFactory? factory=null;WhisperProcessor? whisper=null;Model? voskModel=null;
if(modelName=="vosk"){Vosk.Vosk.SetLogLevel(-1);voskModel=new Model(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Misty","Voice","vosk-model-small-en-us-0.15"));}
else
{
 var modelPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Misty","Voice","ggml-"+modelName+".bin");
 factory=WhisperFactory.FromPath(modelPath,new WhisperFactoryOptions{UseGpu=false});
 whisper=factory.CreateBuilder().WithLanguage("en").WithThreads(threads).WithNoContext().WithProbabilities().Build();
}
var loadSeconds=load.Elapsed.TotalSeconds;proc.Refresh();var loadedMB=proc.WorkingSet64/1048576.0;
var rows=new List<object>();var latencies=new List<double>();var totalErrors=0;var totalWords=0;var falseText=0;
foreach(var fixture in fixturesToRun)
{
 proc.Refresh();var cpuBefore=proc.TotalProcessorTime;var timer=Stopwatch.StartNew();var text="";var probability=0.0;var segments=0;
 using var reader=new WaveFileReader(fixture.Path);var audioSeconds=reader.TotalTime.TotalSeconds;
 if(voskModel!=null)
 {
  using var rec=new VoskRecognizer(voskModel,16000);var buffer=new byte[3200];int count;var parts=new List<string>();
  while((count=reader.Read(buffer,0,buffer.Length))>0)if(rec.AcceptWaveform(buffer,count)){using var d=JsonDocument.Parse(rec.Result());parts.Add(d.RootElement.GetProperty("text").GetString()??"");}
  using(var d=JsonDocument.Parse(rec.FinalResult()))parts.Add(d.RootElement.GetProperty("text").GetString()??"");text=string.Join(" ",parts).Trim();
 }
 else
 {
  using var stream=File.OpenRead(fixture.Path);var parts=new List<string>();
  await foreach(var segment in whisper!.ProcessAsync(stream)){parts.Add(segment.Text);probability+=segment.Probability;segments++;}text=string.Join(" ",parts).Trim();
 }
 var seconds=timer.Elapsed.TotalSeconds;proc.Refresh();var cpu=(proc.TotalProcessorTime-cpuBefore).TotalSeconds;var errors=Distance(fixture.Expected,text);var words=Normalize(fixture.Expected).Length;
 if(words>0){totalErrors+=errors;totalWords+=words;latencies.Add(seconds);}else if(text.Length>0)falseText++;
 rows.Add(new {fixture.Path,fixture.Expected,fixture.Voice,text,words,errors,seconds,audioSeconds,realTimeFactor=seconds/audioSeconds,cpuSeconds=cpu,cpuCorePercent=100*cpu/seconds,cpuMachinePercent=100*cpu/seconds/Environment.ProcessorCount,workingSetMB=proc.WorkingSet64/1048576.0,probability=segments>0?probability/segments:0});
 Console.WriteLine(JsonSerializer.Serialize(new {fixture=Path.GetFileName(fixture.Path),seconds,errors,words,text}));
}
proc.Refresh();latencies.Sort();var report=new {model=modelName,threads,at=DateTimeOffset.UtcNow,fixtureKind="Synthetic Windows TTS only; not owner-accent accuracy",loadSeconds,loadedWorkingSetMB=loadedMB,peakWorkingSetMB=proc.PeakWorkingSet64/1048576.0,cpuSeconds=(proc.TotalProcessorTime-startCpu).TotalSeconds,totalWords,totalErrors,wordErrorRate=(double)totalErrors/totalWords,nonSpeechFalseTranscripts=falseText,medianSeconds=latencies[latencies.Count/2],p95Seconds=latencies[(int)Math.Ceiling(latencies.Count*.95)-1],rows};
var output=Path.Combine(root,$"{modelName}-{threads}threads-{DateTime.UtcNow:HHmmss}.json");File.WriteAllText(output,JsonSerializer.Serialize(report,new JsonSerializerOptions{WriteIndented=true}));Console.WriteLine("REPORT "+output);
whisper?.Dispose();factory?.Dispose();voskModel?.Dispose();
record Fixture(string Path,string Expected,string Voice);