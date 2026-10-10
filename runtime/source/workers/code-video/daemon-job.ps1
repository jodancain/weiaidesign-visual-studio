param(
 [Parameter(Mandatory=$true)][string]$Node,
 [Parameter(Mandatory=$true)][string]$Script,
 [Parameter(Mandatory=$true)][string]$WorkingDirectory,
 [Parameter(Mandatory=$true)][string]$StdoutLog,
 [Parameter(Mandatory=$true)][string]$StderrLog,
 [Parameter(Mandatory=$true)][string]$LifecyclePath
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Worker daemon requires a limited interactive token'}
if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'Worker daemon requires an interactive session'}
foreach($file in @($Node,$Script)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'Worker executable or script is missing'}}
foreach($file in @($StdoutLog,$StderrLog,$LifecyclePath)){New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file)|Out-Null}
# The only inheritable handles are stdio. In particular the JobObject handle is
# private to this foreground PowerShell task: stopping the task closes it even
# when PowerShell cannot run finally. Nested per-render jobs remain supported.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class StudioDaemonJob {
 [StructLayout(LayoutKind.Sequential)] struct SA {public int nLength;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {public int cb;public IntPtr reserved,desktop,title;public int x,y,xsize,ysize,xchars,ychars,fill,flags;public short show,reserved2;public IntPtr reserved2ptr,stdin,stdout,stderr;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct BASIC {public long processTime,jobTime;public uint flags;public UIntPtr minWs,maxWs;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong rOps,wOps,oOps,rBytes,wBytes,oBytes;}
 [StructLayout(LayoutKind.Sequential)] struct EXT {public BASIC basic;public IO io;public UIntPtr processMem,jobMem,peakProcessMem,peakJobMem;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string path,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr process,uint exit);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref SI startup,out PI process);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 static string Quote(string value){var b=new StringBuilder("\"");int slash=0;foreach(char c in value){if(c=='\\'){slash++;continue;}if(c=='\"'){b.Append('\\',slash*2+1).Append(c);slash=0;continue;}b.Append('\\',slash).Append(c);slash=0;}return b.Append('\\',slash*2).Append('"').ToString();}
 static string Json(string value){var b=new StringBuilder("\"");foreach(char c in value){if(c=='\\'||c=='"')b.Append('\\').Append(c);else if(c<32)b.Append("\\u").Append(((int)c).ToString("x4"));else b.Append(c);}return b.Append('"').ToString();}
 static void Receipt(string path,string state,string started,string exe,string script,string cwd,uint pid,int? exit){
  var p=Process.GetCurrentProcess();string data="{\"schemaVersion\":1,\"state\":"+Json(state)+",\"at\":"+Json(DateTime.UtcNow.ToString("o"))+",\"startedAt\":"+Json(started)+",\"parentPid\":"+p.Id+",\"childPid\":"+pid+",\"sessionId\":"+p.SessionId+",\"limitedToken\":true,\"assignedBeforeResume\":true,\"killOnJobClose\":true,\"jobHandleInherited\":false,\"gpuMutexAcquired\":false,\"timeoutSeconds\":null,\"executable\":"+Json(exe)+",\"script\":"+Json(script)+",\"workingDirectory\":"+Json(cwd)+",\"exitCode\":"+(exit.HasValue?exit.Value.ToString():"null")+"}";
  string temp=path+".tmp-"+p.Id;File.WriteAllText(temp,data,new UTF8Encoding(false));if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path);
 }
 public static int Run(string exe,string script,string cwd,string stdout,string stderr,string receipt){
  IntPtr job=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,input=IntPtr.Zero,buffer=IntPtr.Zero;PI pi=new PI();bool assigned=false;string started=DateTime.UtcNow.ToString("o");
  try{
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
   if(!SetHandleInformation(job,1,0))throw new Win32Exception();
   var info=new EXT();info.basic.flags=0x2000;int length=Marshal.SizeOf(info);buffer=Marshal.AllocHGlobal(length);Marshal.StructureToPtr(info,buffer,false);
   if(!SetInformationJobObject(job,9,buffer,(uint)length))throw new Win32Exception();
   var sa=new SA();sa.nLength=Marshal.SizeOf(sa);sa.inherit=true;
   output=CreateFile(stdout,4,7,ref sa,4,128,IntPtr.Zero);error=CreateFile(stderr,4,7,ref sa,4,128,IntPtr.Zero);input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);
   if(output==new IntPtr(-1)||error==new IntPtr(-1)||input==new IntPtr(-1))throw new Win32Exception();
   var si=new SI();si.cb=Marshal.SizeOf(si);si.flags=0x100;si.stdin=input;si.stdout=output;si.stderr=error;
   if(!CreateProcess(exe,new StringBuilder(Quote(exe)+" "+Quote(script)),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi))throw new Win32Exception();
   if(!AssignProcessToJobObject(job,pi.process)){int failure=Marshal.GetLastWin32Error();TerminateProcess(pi.process,1);throw new Win32Exception(failure);}assigned=true;
   Receipt(receipt,"starting",started,exe,script,cwd,pi.pid,null);
   if(ResumeThread(pi.thread)==0xffffffff)throw new Win32Exception();
   Receipt(receipt,"running",started,exe,script,cwd,pi.pid,null);
   uint wait=WaitForSingleObject(pi.process,0xffffffff);if(wait!=0)throw new Win32Exception();
   uint code;if(!GetExitCodeProcess(pi.process,out code))throw new Win32Exception();
   Receipt(receipt,"exited",started,exe,script,cwd,pi.pid,unchecked((int)code));return unchecked((int)code);
  }finally{
   if(!assigned&&pi.process!=IntPtr.Zero)TerminateProcess(pi.process,1);
   if(job!=IntPtr.Zero)CloseHandle(job);
   if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);
   foreach(var h in new[]{output,error,input})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);
  }
 }
}
'@
$result=[StudioDaemonJob]::Run($Node,$Script,$WorkingDirectory,$StdoutLog,$StderrLog,$LifecyclePath)
exit $result
