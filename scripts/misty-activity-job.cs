// Keep the telemetry process tree owned by its scheduled-task wrapper. Windows
// Task Scheduler can stop PowerShell while leaving ordinary child processes alive.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MistyActivityJob {
 // Compile as winexe so Task Scheduler never allocates a console on startup.
 public static int Main(string[] args) {
  if(args.Length!=2)return 2;
  try {return Run(args[0],Path.Combine(args[1],"scripts/misty-activity-agent.mjs"),args[1]);}
  catch(Exception error) {
   try {File.WriteAllText(Path.Combine(args[1],"data/deployment/laptop-activity/wrapper-error.log"),DateTime.UtcNow.ToString("o")+" "+error.Message);}catch{}
   return 1;
  }
 }
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
  public long processTime, jobTime; public uint flags;
  public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcesses;
  public UIntPtr affinity; public uint priority, scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters {
  public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
 }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
  public BasicLimit basic; public IoCounters io;
  public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimit data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int Run(string node,string script,string directory) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null);
  if(job==IntPtr.Zero)throw new Win32Exception();
  try {
   var limits=new ExtendedLimit();limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
   if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))))throw new Win32Exception();
   var start=new ProcessStartInfo(node,"--disable-warning=ExperimentalWarning \""+script+"\"");
   start.WorkingDirectory=directory;start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardError=true;
   using(var process=Process.Start(start)) {
    var errors=new StringBuilder();
    process.ErrorDataReceived+=(sender,args)=>{if(args.Data!=null)lock(errors){errors.AppendLine(args.Data);if(errors.Length>4000)errors.Remove(0,errors.Length-4000);}};
    process.BeginErrorReadLine();
    if(!AssignProcessToJobObject(job,process.Handle)) {
     int error=Marshal.GetLastWin32Error();process.Kill();throw new Win32Exception(error);
    }
    process.WaitForExit();
    if(process.ExitCode!=0)lock(errors){File.WriteAllText(Path.Combine(directory,"data/deployment/laptop-activity/worker-error.log"),errors.ToString());}
    return process.ExitCode;
   }
  } finally {CloseHandle(job);}
 }
}
