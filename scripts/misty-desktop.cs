using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class MistyWindow { public string id; public int pid; public string application; public string title; public bool foreground; public bool minimized; }
public class MistyDesktopSample { public long capturedAt; public string sessionState; public bool? locked; public long? idleSeconds; public MistyWindow foreground; public List<MistyWindow> windows = new List<MistyWindow>(); public bool truncated; }
public static class MistyDesktop {
 delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr arg);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, uint length, out uint needed);
 [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size; public uint tick; }
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
 static MistyWindow Window(IntPtr h, IntPtr foreground) {
  if(h==IntPtr.Zero)return null;
  uint pid;GetWindowThreadProcessId(h,out pid);
  try {
   using(var p=Process.GetProcessById((int)pid)) {
    if(p.SessionId!=Process.GetCurrentProcess().SessionId)return null;
    var title=new StringBuilder(513);GetWindowText(h,title,title.Capacity);
    return new MistyWindow{id=h.ToInt64().ToString(),pid=(int)pid,application=p.ProcessName,title=title.ToString(),foreground=h==foreground,minimized=IsIconic(h)};
   }
  } catch {return null;}
 }
 public static MistyDesktopSample Capture() {
  var sample=new MistyDesktopSample{capturedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),sessionState="unknown",locked=null};
  var input=new LastInput{size=(uint)Marshal.SizeOf(typeof(LastInput))};
  if(GetLastInputInfo(ref input))sample.idleSeconds=(long)(unchecked((uint)Environment.TickCount-input.tick)/1000);
  IntPtr desktop=OpenInputDesktop(0,false,1);
  if(desktop==IntPtr.Zero){sample.sessionState="locked_or_secure_desktop";return sample;}
  var name=new StringBuilder(128);uint needed;
  bool readable=GetUserObjectInformation(desktop,2,name,256,out needed);CloseDesktop(desktop);
  if(!readable){sample.sessionState="desktop_unavailable";return sample;}
  if(!String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase)){sample.locked=true;sample.sessionState="locked_or_secure_desktop";return sample;}
  sample.locked=false;sample.sessionState=sample.idleSeconds.HasValue&&sample.idleSeconds.Value>=300?"idle":"active";
  IntPtr front=GetForegroundWindow();sample.foreground=Window(front,front);
  EnumWindows(delegate(IntPtr h,IntPtr arg) {
   if(sample.windows.Count>=120){sample.truncated=true;return false;}
   if(!IsWindowVisible(h)||GetWindow(h,4)!=IntPtr.Zero)return true;
   int cloaked;if(DwmGetWindowAttribute(h,14,out cloaked,4)==0&&cloaked!=0)return true;
   var w=Window(h,front);if(w!=null&&!String.IsNullOrWhiteSpace(w.title))sample.windows.Add(w);
   return true;
  },IntPtr.Zero);
  return sample;
 }
}

// GUI subsystem executable: stdin/stdout are inherited pipes, never a console.
public static class MistyDesktopEntry {
 public static int Main(string[] args) {
  try {
   var input=new System.IO.StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false));
   var output=new System.IO.StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false));output.AutoFlush=true;
   var json=new System.Web.Script.Serialization.JavaScriptSerializer();
   string request;
   while((request=input.ReadLine())!=null) {
    if(request=="sample")output.WriteLine(json.Serialize(MistyDesktop.Capture()));
   }
   return 0;
  } catch{return 1;}
 }
}
