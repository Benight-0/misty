using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;
public static class MistyChromeLauncher {
 static string Quote(string value){return "\""+value.Replace("\"", "\\\"")+"\"";}
 static void Pump(Stream input,Stream output){
  var buffer=new byte[8192];int count;
  while((count=input.Read(buffer,0,buffer.Length))>0){output.Write(buffer,0,count);output.Flush();}
 }
 public static int Main(string[] args){
  try {
   string dir=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
   var cfg=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(File.ReadAllText(Path.Combine(dir,"config.json")));
   if(args.Length<1||args[0]!=cfg["origin"])return 2;
   var start=new ProcessStartInfo(cfg["node"],Quote(cfg["script"])+" "+Quote(args[0]));
   start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
   using(var child=Process.Start(start)){
    var input=new Thread(()=>{try{Pump(Console.OpenStandardInput(),child.StandardInput.BaseStream);child.StandardInput.Close();}catch{}});input.IsBackground=true;input.Start();
    var output=new Thread(()=>{try{Pump(child.StandardOutput.BaseStream,Console.OpenStandardOutput());}catch{}});output.Start();
    child.StandardError.BaseStream.CopyTo(Stream.Null);child.WaitForExit();output.Join();return child.ExitCode;
   }
  } catch{return 1;}
 }
}
