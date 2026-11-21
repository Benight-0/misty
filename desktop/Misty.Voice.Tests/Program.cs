using System.Speech.Synthesis;
using System.Speech.AudioFormat;
using System.Reflection;
using Misty.Overlay;
void Assert(bool condition,string message){if(!condition)throw new Exception(message);Console.WriteLine("PASS "+message);}
Assert(LocalVoice.SpokenText("read [this](https://example.org) and `code`")=="read this and code","Speech text removes formatting and URLs");
Assert(!LocalVoice.SpokenText("```cs\nsecret code\n```").Contains("secret"),"Code blocks not read aloud");
foreach(var background in new[]{"he lasted","you are new to him","this cannot be real","what americans are you located","James Bond double oh seven","(buzzing)","[BLANK_AUDIO]"})
 Assert(WhisperTranscriber.Command(background,true)=="","Reject background without verified wake: "+background);
Assert(WhisperTranscriber.Command("Misty, can you hear me now?",true)=="can you hear me now?","Strip independently verified wake");
Assert(WhisperTranscriber.Command("yes",false)=="yes","Keyboard request does not require a wake word");
using var synth=new SpeechSynthesizer();synth.SelectVoice("Microsoft Zira Desktop");
byte[] Pcm(string text)
{
 using var pcm=new MemoryStream();synth.SetOutputToAudioStream(pcm,new SpeechAudioFormatInfo(16000,AudioBitsPerSample.Sixteen,AudioChannel.Mono));synth.Speak(text);synth.SetOutputToNull();return pcm.ToArray().Concat(new byte[64000]).ToArray();
}
async Task TestPipeline(string phrase,bool expectCommand,bool forceCandidate=false)
{
 using var live=new LocalVoice();live.StateChanged+=state=>Console.WriteLine("STATE "+state);live.Start();Assert(live.InputAvailable,"Default microphone initialised");
 ((NAudio.Wave.WaveInEvent)typeof(LocalVoice).GetField("microphone",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(live)!).StopRecording();
 var completion=new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);live.Transcript+=text=>completion.TrySetResult(text);
 if(forceCandidate)typeof(LocalVoice).GetMethod("BeginListening",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(live,new object[]{true});
 var bytes=Pcm(phrase);var feed=typeof(LocalVoice).GetMethod("ProcessAudio",BindingFlags.NonPublic|BindingFlags.Instance)!;
 for(var offset=0;offset<bytes.Length;offset+=3200){var chunk=bytes.Skip(offset).Take(3200).ToArray();feed.Invoke(live,new object[]{chunk,chunk.Length});}
 if(expectCommand)
 {
  var text=await completion.Task.WaitAsync(TimeSpan.FromSeconds(15));
  Assert(text.Contains("tell me the time",StringComparison.OrdinalIgnoreCase),"Whisper request pipeline: "+text);
  Assert(!text.StartsWith("misty",StringComparison.OrdinalIgnoreCase),"Wake word removed before backend");
 }
 else
 {
  var deadline=DateTime.UtcNow.AddSeconds(15);while(live.LastRecognition==null&&DateTime.UtcNow<deadline)await Task.Delay(50);
  Assert(live.LastRecognition!=null,"Candidate independently decoded");Assert(!completion.Task.IsCompleted,"False Vosk candidate never forwarded");Assert(live.RejectedWakeCount==1,"Rejected wake counted");
 }
}
await TestPipeline("Misty please tell me the time",true);
await TestPipeline("This cannot be real",false,true);
using(var live=new LocalVoice())
{
 live.Start();((NAudio.Wave.WaveInEvent)typeof(LocalVoice).GetField("microphone",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(live)!).StopRecording();
 typeof(LocalVoice).GetMethod("BeginListening",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(live,new object[]{true});
 var feed=typeof(LocalVoice).GetMethod("ProcessAudio",BindingFlags.NonPublic|BindingFlags.Instance)!;
 var noise=new byte[96000];var rng=new Random(4);for(var i=0;i<noise.Length;i+=2){short n=(short)rng.Next(-100,100);noise[i]=(byte)n;noise[i+1]=(byte)(n>>8);}
 for(var offset=0;offset<noise.Length;offset+=3200)feed.Invoke(live,new object[]{noise.Skip(offset).Take(3200).ToArray(),3200});
 typeof(LocalVoice).GetMethod("FinishCapture",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(live,null);
 Assert(live.LastRecognition==null,"Quiet noise rejected before Whisper inference");Assert(!live.Listening,"Empty request ends without sending");
}
Console.WriteLine("All native voice checks passed; zero synthetic owner inputs sent");
