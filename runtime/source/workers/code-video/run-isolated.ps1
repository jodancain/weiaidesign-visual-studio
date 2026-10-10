param([string]$Node,[string]$Script,[string]$JobDirectory)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$identity=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if($identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Desktop GPU work requires a limited token'}
if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'Interactive desktop session required'}
$attemptId='attempt-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N')
$attemptRoot=Join-Path $JobDirectory 'attempts'
New-Item -ItemType Directory -Force -Path $attemptRoot|Out-Null
$attemptDirectory=Join-Path $attemptRoot $attemptId
New-Item -ItemType Directory -Path $attemptDirectory|Out-Null
$stdoutPath=Join-Path $attemptDirectory 'process.stdout.log'
$stderrPath=Join-Path $attemptDirectory 'process.stderr.log'
$launcherHash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLower()
@{schemaVersion=1;attemptId=$attemptId;startedAt=[DateTime]::UtcNow.ToString('o');jobDirectory=$JobDirectory;script=$Script;node=$Node;launcherSHA256=$launcherHash;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $attemptDirectory 'attempt.json') -Encoding UTF8
$mutexName=if($env:STUDIO_GPU_MUTEX){$env:STUDIO_GPU_MUTEX}else{'Global\WeiaiStudioGpuV1'}
$mutexSecurity=New-Object System.Security.AccessControl.MutexSecurity
$accountSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutexSecurity.SetSecurityDescriptorSddlForm(('D:P(A;;GA;;;SY)(A;;GA;;;'+$accountSid+')'))
$mutexCreated=$false
$mutex=New-Object System.Threading.Mutex($false,$mutexName,[ref]$mutexCreated,$mutexSecurity)
$locked=$false
try {
  try {$locked=$mutex.WaitOne()} catch [System.Threading.AbandonedMutexException] {$locked=$true}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class IsolatedPilot {
 [StructLayout(LayoutKind.Sequential)] struct SA {public int nLength;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {public int cb;public IntPtr reserved,desktop,title;public int x,y,xsize,ysize,xchars,ychars,fill,flags;public short show,reserved2;public IntPtr reserved2ptr,stdin,stdout,stderr;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct BASIC {public long processTime,jobTime;public uint flags;public UIntPtr minWs,maxWs;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong rOps,wOps,oOps,rBytes,wBytes,oBytes;}
 [StructLayout(LayoutKind.Sequential)] struct EXT {public BASIC basic;public IO io;public UIntPtr processMem,jobMem,peakProcessMem,peakJobMem;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string path,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateJobObject(IntPtr job,uint exit);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr process,uint exit);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref SI startup,out PI process);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 public class Result {public uint pid;public int exitCode;public bool timedOut,assignedBeforeResume;public double elapsedSeconds;}
 public static Result Run(string exe,string arguments,string cwd,string stdout,string stderr,uint timeout) {
  IntPtr job=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,input=IntPtr.Zero,buffer=IntPtr.Zero;PI pi=new PI();var watch=Stopwatch.StartNew();bool assigned=false;
  try {
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
   var info=new EXT();info.basic.flags=0x2000;int length=Marshal.SizeOf(info);buffer=Marshal.AllocHGlobal(length);Marshal.StructureToPtr(info,buffer,false);
   if(!SetInformationJobObject(job,9,buffer,(uint)length))throw new Win32Exception();
   var sa=new SA();sa.nLength=Marshal.SizeOf(sa);sa.inherit=true;
   output=CreateFile(stdout,0x40000000,3,ref sa,1,0,IntPtr.Zero);if(output==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot create attempt stdout");
   error=CreateFile(stderr,0x40000000,3,ref sa,1,0,IntPtr.Zero);if(error==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot create attempt stderr");
   input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);if(input==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot open child stdin");
   var si=new SI();si.cb=Marshal.SizeOf(si);si.flags=0x100;si.stdin=input;si.stdout=output;si.stderr=error;
   if(!CreateProcess(exe,new StringBuilder("\""+exe+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi))throw new Win32Exception();
   if(!AssignProcessToJobObject(job,pi.process)){int failure=Marshal.GetLastWin32Error();TerminateProcess(pi.process,1);throw new Win32Exception(failure);}assigned=true;
   if(ResumeThread(pi.thread)==0xffffffff)throw new Win32Exception();
   uint wait=WaitForSingleObject(pi.process,timeout);bool timedOut=wait==258;
   if(wait==0xffffffff)throw new Win32Exception();if(timedOut){if(!TerminateJobObject(job,124))throw new Win32Exception();WaitForSingleObject(pi.process,5000);}
   uint code;if(!GetExitCodeProcess(pi.process,out code))throw new Win32Exception();
   return new Result{pid=pi.pid,exitCode=unchecked((int)code),timedOut=timedOut,assignedBeforeResume=assigned,elapsedSeconds=watch.Elapsed.TotalSeconds};
  } finally {if(job!=IntPtr.Zero)CloseHandle(job);if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);foreach(var h in new[]{output,error,input})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);}
 }
}
'@

  $arguments='"'+$Script+'" "'+$JobDirectory+'"'
  $result=[IsolatedPilot]::Run($Node,$arguments,(Split-Path -Parent $Script),$stdoutPath,$stderrPath,14400000)
  @{schemaVersion=2;attemptId=$attemptId;pid=$result.pid;exitCode=$result.exitCode;timedOut=$result.timedOut;assignedBeforeResume=$result.assignedBeforeResume;elapsedSeconds=$result.elapsedSeconds;launcherSHA256=$launcherHash;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $attemptDirectory 'process-receipt.json') -Encoding UTF8
  if($result.exitCode -ne 0){
   [Console]::Error.WriteLine(('Worker child exit '+$result.exitCode+'; timedOut='+$result.timedOut))
   [Console]::Error.WriteLine([IO.File]::ReadAllText($stderrPath,[Text.Encoding]::UTF8))
   exit $result.exitCode
  }
} catch {
 @{at=[DateTime]::UtcNow.ToString('o');attemptId=$attemptId;error=$_.Exception.Message;nativeErrorCode=$_.Exception.InnerException.NativeErrorCode;launcherSHA256=$launcherHash}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $attemptDirectory 'launcher-error.json') -Encoding UTF8
 throw
} finally {if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
