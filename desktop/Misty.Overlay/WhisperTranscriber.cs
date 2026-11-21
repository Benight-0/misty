using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Whisper.net;

namespace Misty.Overlay;

internal sealed record RecognitionResult(string Text,double Confidence,double AudioSeconds,double Milliseconds,double CpuSeconds,double MachineCpuPercent,double PeakWorkingSetMB,string Model);
internal static class WhisperTranscriber
{
    private static readonly SemaphoreSlim gate=new(1,1);
    internal static string ModelName => "base.en-q5_1";
    internal static string ModelPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Misty","Voice","ggml-"+ModelName+".bin");
    internal static async Task<RecognitionResult> RecognizeAsync(byte[] pcm,CancellationToken cancellation=default)
    {
        await gate.WaitAsync(cancellation);
        try
        {
            var process=Process.GetCurrentProcess();var cpu=process.TotalProcessorTime;var watch=Stopwatch.StartNew();
            using var factory=WhisperFactory.FromPath(ModelPath,new WhisperFactoryOptions{UseGpu=false});
            using var processor=factory.CreateBuilder().WithLanguage("en").WithThreads(2).WithNoContext().WithProbabilities().Build();
            using var wav=new MemoryStream();
            using(var writer=new BinaryWriter(wav,Encoding.ASCII,true))
            {
                writer.Write(Encoding.ASCII.GetBytes("RIFF"));writer.Write(pcm.Length+36);writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
                writer.Write(16);writer.Write((short)1);writer.Write((short)1);writer.Write(16000);writer.Write(32000);writer.Write((short)2);writer.Write((short)16);
                writer.Write(Encoding.ASCII.GetBytes("data"));writer.Write(pcm.Length);writer.Write(pcm);
            }
            wav.Position=0;var text=new StringBuilder();double confidence=0;var segments=0;
            await foreach(var segment in processor.ProcessAsync(wav,cancellation))
            { text.Append(segment.Text).Append(' ');confidence+=segment.Probability;segments++; }
            process.Refresh();var elapsed=watch.Elapsed.TotalMilliseconds;var cpuSeconds=(process.TotalProcessorTime-cpu).TotalSeconds;
            return new(text.ToString().Trim(),segments>0?confidence/segments:0,pcm.Length/32000.0,elapsed,cpuSeconds,
                elapsed>0?cpuSeconds*100000/elapsed/Environment.ProcessorCount:0,process.PeakWorkingSet64/1048576.0,ModelName);
        }
        finally { gate.Release(); }
    }
    internal static string Command(string text,bool requireWake)
    {
        text=text.Trim();
        if(text.Length==0 || Regex.IsMatch(text,@"^[\[(].*[\])]$"))return "";
        var wake=Regex.Match(text,@"^(?:(?:hey|hi|okay|ok)[,\s]+)?misty\b[\s,:.!?—-]*",RegexOptions.IgnoreCase);
        if(requireWake && !wake.Success)return "";
        return wake.Success?text[wake.Length..].Trim():text;
    }
    internal static bool ContainsWake(string text)=>Regex.IsMatch(text.Trim(),@"^(?:(?:hey|hi|okay|ok)[,\s]+)?misty\b",RegexOptions.IgnoreCase);
}