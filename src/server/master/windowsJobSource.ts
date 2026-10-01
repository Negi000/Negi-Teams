// Trusted supervisor source, compiled by the parent into its private run output.
// Windows 10+ JOB_LIST assigns containment atomically at CreateProcess, avoiding
// the suspended-but-unassigned orphan window. No shell or breakaway is enabled.
export const windowsJobSource = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class NegiJob {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long a,b; public uint flags; public UIntPtr min,max; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXT_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr process,job,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {
    public long a,b,c,d; public uint faults,total,active,terminated;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUP {
    public uint cb; public string reserved,desktop,title; public uint x,y,w,h,charsX,charsY,fill,flags;
    public ushort show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUP_EX { public STARTUP startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXT_LIMIT value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNT value,uint size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUP_EX startup,out PROCESS process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool PeekNamedPipe(IntPtr pipe,IntPtr buffer,uint size,IntPtr read,out uint available,IntPtr remaining);

  static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static string Quote(string value) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') {slashes++;continue;}
      if(c=='"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes);
      slashes=0;b.Append(c);
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  static uint Active(IntPtr job) {
    ACCOUNT a; Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),"QueryJob"); return a.active;
  }
  static int Main(string[] args) {
    IntPtr job=IntPtr.Zero,attributes=IntPtr.Zero,jobs=IntPtr.Zero,handles=IntPtr.Zero,environment=IntPtr.Zero;
    IntPtr[] duplicates=new IntPtr[3]; PROCESS process=new PROCESS(); bool created=false,attributesInitialized=false;
    StreamWriter writer=null; NamedPipeClientStream pipe=null; var json=new JavaScriptSerializer { MaxJsonLength=1000000 };
    try {
      if(args.Length!=1) throw new Exception("Supervisor arguments invalid");
      {
        pipe=new NamedPipeClientStream(".",args[0],PipeDirection.InOut);
        pipe.Connect(10000);
        var reader=new StreamReader(pipe,new UTF8Encoding(false),false,4096,true);
        writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true) {AutoFlush=true};
        string token=Environment.GetEnvironmentVariable("NEGI_JOB_TOKEN");
        writer.WriteLine(json.Serialize(new {kind="hello",token=token}));
        var config=json.Deserialize<Dictionary<string,object>>(reader.ReadLine());
        string executable=(string)config["executable"],cwd=(string)config["cwd"];
        var argv=(System.Collections.IEnumerable)config["args"]; var variables=(Dictionary<string,object>)config["env"];
        var command=new StringBuilder(Quote(executable)); foreach(object a in argv) command.Append(' ').Append(Quote((string)a));
        if(command.Length>30000) throw new Exception("Command line too long");
        job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception();
        var limits=new EXT_LIMIT(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway flags
        Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT_LIMIT))),"SetJobLimits");
        IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);
        attributes=Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(attributes,2,0,ref bytes),"InitializeAttributes");
        attributesInitialized=true;
        jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
        Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"SetJobList");
        handles=Marshal.AllocHGlobal(IntPtr.Size*3);
        for(int i=0;i<3;i++) {
          Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-10-i),GetCurrentProcess(),out duplicates[i],0,true,2),"DuplicateStdio");
          Marshal.WriteIntPtr(handles,i*IntPtr.Size,duplicates[i]);
        }
        Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"SetHandleList");
        var env=new StringBuilder(); var keys=new List<string>(variables.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
        foreach(string k in keys) { if(k.IndexOf('=')>=0||k.IndexOf('\0')>=0) throw new Exception("Environment key invalid");env.Append(k).Append('=').Append((string)variables[k]).Append('\0'); }
        env.Append('\0');environment=Marshal.StringToHGlobalUni(env.ToString());
        var startup=new STARTUP_EX();startup.startup.cb=(uint)Marshal.SizeOf(typeof(STARTUP_EX));startup.attributes=attributes;
        startup.startup.flags=0x100;startup.startup.input=duplicates[0];startup.startup.output=duplicates[1];startup.startup.error=duplicates[2];
        Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x08000000,environment,cwd,ref startup,out process),"CreateContainedProcess");
        created=true;
        // Only the supervisor holds the job handle. Children inherit the three stdio handles only.
        for(int i=0;i<3;i++) {CloseHandle(duplicates[i]);duplicates[i]=IntPtr.Zero;}
        writer.WriteLine(json.Serialize(new {kind="started",rootPid=process.pid}));
        uint wait;
        while((wait=WaitForSingleObject(process.process,50))==0x102) {
          // Nonblocking peek lets termination evidence use the same pipe. Any
          // control bytes, parent EOF or channel failure stop only this job.
          uint available;
          if(!PeekNamedPipe(pipe.SafePipeHandle.DangerousGetHandle(),IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)||available>0)
            Check(TerminateJobObject(job,143),"StopJob");
        }
        Check(wait==0,"WaitForRoot");
        uint exitCode;Check(GetExitCodeProcess(process.process,out exitCode),"ReadRootExit");
        // A root can exit while leaving detached children. They must not survive settlement.
        if(Active(job)>0) Check(TerminateJobObject(job,143),"StopResidualChildren");
        DateTime until=DateTime.UtcNow.AddSeconds(10);
        while(Active(job)>0) {if(DateTime.UtcNow>until) throw new Exception("Job remains active");Thread.Sleep(10);}
        writer.WriteLine(json.Serialize(new {kind="empty",rootPid=process.pid,active=0,rootCode=exitCode}));
        // The parent acknowledges processing the empty event before the helper
        // exits, so independent stdio/control event ordering cannot lose proof.
        until=DateTime.UtcNow.AddSeconds(10);var acknowledgment=new StringBuilder();bool acknowledged=false;
        while(!acknowledged) {
          uint available;
          if(!PeekNamedPipe(pipe.SafePipeHandle.DangerousGetHandle(),IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero))throw new Exception("Parent closed before acknowledgment");
          if(available==0) {if(DateTime.UtcNow>until)throw new Exception("Parent acknowledgment timed out");Thread.Sleep(10);continue;}
          int value=pipe.ReadByte();if(value<0)throw new Exception("Parent channel closed");
          if(value==10) {acknowledged=acknowledgment.ToString()=="ack";acknowledgment.Clear();}
          else {acknowledgment.Append((char)value);if(acknowledgment.Length>32)throw new Exception("Parent control invalid");}
        }
        return 0;
      }
    } catch(Exception e) {
      if(writer!=null) {try {writer.WriteLine(json.Serialize(new {kind="error",error=e.GetType().Name+": "+e.Message}));} catch {}}
      return 1;
    } finally {
      // Closing the non-inherited job handle also contains supervisor/parent failure.
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(pipe!=null) pipe.Dispose();
      if(created) {CloseHandle(process.thread);CloseHandle(process.process);}
      if(attributes!=IntPtr.Zero) {if(attributesInitialized) DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}
      if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment);
      foreach(IntPtr h in duplicates) if(h!=IntPtr.Zero) CloseHandle(h);
    }
  }
}
`;
