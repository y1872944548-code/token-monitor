using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Drawing.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

sealed class FloatingPulse : Form {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr window,System.Text.StringBuilder text,int size);
  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32First(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32Next(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct ProcessEntry {public uint Size,Usage,Pid;public IntPtr Heap;public uint Module,Threads,Parent;public int Priority;public uint Flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string Name;}
  delegate bool WindowVisitor(IntPtr h, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor callback, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
  [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetStyle64(IntPtr h, int n);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetStyle32(IntPtr h, int n);
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  readonly string root, thread, data, client, clientLabel; readonly uint pinnedHost; uint streamLauncher; long streamLauncherStarted; readonly System.Threading.EventWaitHandle showRequest; readonly JavaScriptSerializer json = new JavaScriptSerializer();
  readonly Timer tick = new Timer(); System.Threading.Timer animator, presenceTimer; readonly ToolTip tip = new ToolTip();
  readonly object gate = new object(); readonly Stopwatch clock = Stopwatch.StartNew();
  Process feed; Dictionary<string,object> pending, state, view; volatile bool closing; bool fastTimer; int frameQueued, scanBusy; string feedFailure;
  readonly List<ChatChoice> chatChoices=new List<ChatChoice>();int catalogRevision;string lastControlError,lastScopeKey="";PulseSettingsPopup settingsPopup;double settingsClosedAt=-1;string nodePath;
  sealed class ChatChoice {public string Id,Title;public double Modified;public override string ToString(){return (String.IsNullOrWhiteSpace(Title)?"未命名对话":Title)+"  ·  "+Id.Substring(0,8);}}
  double lastSave=-20, lastPreview=-20, lastDiscovery=-30, dotX, dotY=82, smoothScale=1, dpi=1, zoom=1, fps, fpsSince, scanMs; int painted, animationPeriod=100;string hostProbe="",lastGraphMetric="";
  double Unit { get { return dpi*zoom; } }
  Dictionary<uint,string> ownerProcesses=new Dictionary<uint,string>(); List<double[]> curve=new List<double[]>();
  HashSet<uint> claudeParents=new HashSet<uint>();
  IntPtr owner = IntPtr.Zero; string ownerName = ""; Rect ownerRect;
  bool paused, dragged, resizing, settingsHovered, motion=true, codexVisible, hostReady, feedSuspended, layerAligned, launcherAligned; uint hostPid; HostState pendingHost;
  readonly PulsePanelState panel;readonly PulseLaunchButton launcher;
  static readonly Rectangle SettingsBounds=new Rectangle(478,8,70,34);
  string speedMetric="reported-tps";
  Point dragMouse, dragLocation; Size dragSize;
  const string RunKey="Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  string RunName {get{return client=="codex"?"CodexPulseCompanion":"CodexPulseCompanion-"+client;}}
  sealed class HostState { public IntPtr Handle; public uint Pid; public bool Visible; public Rect Bounds; public double ScanMs; public string Probe; }
  string error = "连接中";
  static readonly Color bg = Color.FromArgb(23,35,38), mint = Color.FromArgb(152,239,189), muted = Color.FromArgb(174,194,194);
  Font regular = new Font("Segoe UI",16,FontStyle.Regular,GraphicsUnit.Pixel), small = new Font("Microsoft YaHei UI",12,FontStyle.Regular,GraphicsUnit.Pixel), settingsFont=new Font("Microsoft YaHei UI",14,FontStyle.Bold,GraphicsUnit.Pixel);
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void SetVisibleCore(bool value) { base.SetVisibleCore(value && codexVisible); }
  protected override CreateParams CreateParams { get { CreateParams p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } }
  public FloatingPulse(string projectRoot, string node, string threadId,bool showOnStart=false,bool followThread=false) {
    client=Environment.GetEnvironmentVariable("CODEX_PULSE_CLIENT")??"codex";clientLabel=ClientLabel(client);if(client=="claude-code")speedMetric="official-tps";UInt32.TryParse(Environment.GetEnvironmentVariable("CODEX_PULSE_HOST_PID"),out pinnedHost);
    if(client=="claude-code"&&UInt32.TryParse(Environment.GetEnvironmentVariable("CODEX_PULSE_CLAUDE_LAUNCH_PID"),out streamLauncher))try{using(Process launcherProcess=Process.GetProcessById((int)streamLauncher)){streamLauncherStarted=launcherProcess.StartTime.ToUniversalTime().Ticks;}}catch{streamLauncher=0;}
    data=Environment.GetEnvironmentVariable("CODEX_PULSE_CLIENT_DATA_DIR")??Environment.GetEnvironmentVariable("CODEX_PULSE_DATA_DIR")??Path.Combine(projectRoot,"runtime");Directory.CreateDirectory(data);
    showRequest=new System.Threading.EventWaitHandle(false,System.Threading.EventResetMode.AutoReset,InstanceName(data)+"-show");
    panel=new PulsePanelState(showOnStart);launcher=new PulseLaunchButton();
    launcher.ToggleRequested+=delegate {panel.Toggle();SetHostVisibility(panel.PanelVisible);launcher.SetExpanded(panel.Expanded);SaveEvidence();};
    launcher.DockPositionChanged+=delegate {SaveLayout();SaveEvidence();};
    root=projectRoot; thread=threadId;nodePath=node;json.MaxJsonLength=32*1024*1024; Text=clientLabel+" · Pulse 监控"; Size=new Size(610,108);
    FormBorderStyle=FormBorderStyle.None; StartPosition=FormStartPosition.Manual; ShowInTaskbar=false; TopMost=false;
    BackColor=bg; ForeColor=Color.White; DoubleBuffered=true; AutoScaleMode=AutoScaleMode.None;
    tip.InitialDelay=650;tip.ReshowDelay=250;tip.AutoPopDelay=2500;tip.SetToolTip(this,"拖动移动 · 右键设置");
    try { ApplyDpi(GetDpiForWindow(Handle)); } catch { ApplyDpi(96); }
    Rectangle work=Screen.FromControl(this).WorkingArea;
    Location=new Point(work.Right-Width-24,work.Bottom-Height-90);
    try { string layout=Path.Combine(data,"float-layout.json"); if(File.Exists(layout)) {
      Dictionary<string,object> saved=(Dictionary<string,object>)json.DeserializeObject(File.ReadAllText(layout));
      double? savedZoom=Num(Field(saved,"zoom")); if(savedZoom.HasValue) { zoom=ClampZoom(savedZoom.Value); ApplyDpi((uint)Math.Round(dpi*96)); }
      if(Field(saved,"motion") is bool) motion=(bool)saved["motion"];
      string savedMetric=Convert.ToString(Field(saved,"speedMetric"));if(savedMetric=="characters"||savedMetric=="reported-tps"||savedMetric=="official-tps"&&client=="claude-code")speedMetric=savedMetric;
      launcher.SetDock(Convert.ToString(Field(saved,"launcherSide")),Num(Field(saved,"launcherOffset"))??.35);
      Point p=new Point(Convert.ToInt32(saved["left"]),Convert.ToInt32(saved["top"]));
      Rectangle screen=Screen.GetWorkingArea(p); Location=new Point(Math.Max(screen.Left,Math.Min(screen.Right-Width,p.X)),Math.Max(screen.Top,Math.Min(screen.Bottom-Height,p.Y)));
    } } catch {}
    MouseDown += delegate(object sender, MouseEventArgs e) {
      if(e.Button!=MouseButtons.Left) return;
      if(settingsPopup!=null)settingsPopup.Close();
      double x=e.X/Unit,y=e.Y/Unit;
      if(x>589 && y>87) { resizing=true; dragMouse=Cursor.Position; dragSize=Size; Capture=true; return; }
      if(y<45 && x>584) { panel.HidePanel();SetHostVisibility(false);launcher.SetExpanded(false);return; }
      if(y<45 && x>557) { paused=!paused; if(!paused) { view=state; BuildCurve(); } Invalidate(); return; }
      if(SettingsBounds.Contains((int)x,(int)y)) {ShowSettings();return;}
      dragged=true; dragMouse=Cursor.Position; dragLocation=Location;
    };
    MouseMove += delegate(object sender,MouseEventArgs e) {
      Point p=Cursor.Position;
      if(resizing) SetZoom((dragSize.Width+p.X-dragMouse.X)/(610*dpi));
      else if(dragged) Location=new Point(dragLocation.X+p.X-dragMouse.X,dragLocation.Y+p.Y-dragMouse.Y);
      else {
        bool hover=SettingsBounds.Contains((int)(e.X/Unit),(int)(e.Y/Unit));
        if(hover!=settingsHovered){settingsHovered=hover;Invalidate();}
        Cursor=hover?Cursors.Hand:e.X>Width-22*Unit && e.Y>Height-22*Unit ? Cursors.SizeNWSE : Cursors.Default;
      }
    };
    MouseLeave+=delegate {if(settingsHovered){settingsHovered=false;Invalidate();}Cursor=Cursors.Default;};
    MouseUp += delegate(object sender,MouseEventArgs e) { dragged=false;resizing=false;Capture=false;SaveLayout();SaveEvidence();if(e.Button==MouseButtons.Right)ShowSettings(); };

    try {
      ProcessStartInfo start=CreateFeedStartInfo(root,node,thread,followThread);
      feed=Process.Start(start); feed.ErrorDataReceived += delegate(object sender,DataReceivedEventArgs e) { if(e.Data!=null) LogError(e.Data); }; feed.BeginErrorReadLine();
      System.Threading.Tasks.Task.Factory.StartNew(delegate {
        try { while(!closing) { string line=feed.StandardOutput.ReadLine(); if(line==null) { if(!closing) lock(gate) feedFailure="数据源已停止"; break; }
          Dictionary<string,object> parsed;if(!TryParseSnapshot(line,out parsed)){LogError("Rejected malformed data frame; payload omitted");lock(gate)feedFailure="数据格式异常，等候重试";continue;}
          lock(gate) {object catalog;if(pending!=null&&pending.TryGetValue("catalog",out catalog)&&!parsed.ContainsKey("catalog"))parsed["catalog"]=catalog;pending=parsed;feedFailure=null;}
        } } catch(Exception ex) { if(!closing) { LogError("Feed reader stopped: "+ex.GetType().Name); lock(gate) feedFailure="数据读取失败"; } }
      },System.Threading.Tasks.TaskCreationOptions.LongRunning);
    } catch { error="数据源启动失败"; }
    tick.Interval=100; tick.Tick+=delegate {
      if(showRequest.WaitOne(0))panel.ShowPanel();UpdateFeed(); double seconds=clock.Elapsed.TotalSeconds;
      HostState host; lock(gate) { host=pendingHost;pendingHost=null; }
      if(host!=null) { owner=host.Handle;hostPid=host.Pid;ownerRect=host.Bounds;ownerName=host.Pid==0?"":clientLabel;scanMs=host.ScanMs;hostProbe=host.Probe;hostReady=true;
      }
      if(hostReady){bool shown=owner!=IntPtr.Zero&&IsWindow(owner)&&IsWindowVisible(owner)&&!IsIconic(owner);panel.UpdateHost(shown,hostPid);SetHostVisibility(panel.PanelVisible);
        Rect bounds;if(shown&&GetWindowRect(owner,out bounds))ownerRect=bounds;
        uint hostDpi=96;if(shown)try{hostDpi=GetDpiForWindow(owner);}catch{}
        launcher.Sync(new Rectangle(ownerRect.Left,ownerRect.Top,ownerRect.Right-ownerRect.Left,ownerRect.Bottom-ownerRect.Top),hostDpi,panel.LauncherVisible,panel.Expanded);
      }
      bool popupOpen=settingsPopup!=null&&settingsPopup.Visible;
      layerAligned=Visible&&owner!=IntPtr.Zero&&!popupOpen&&AlignCompanionLayer(Handle,owner);
      launcherAligned=launcher.Visible&&owner!=IntPtr.Zero&&!popupOpen&&AlignCompanionLayer(launcher.Handle,Visible?Handle:owner);
      tick.Interval=Visible||launcher.Visible?100:250;
      double now=(DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;
      double? activity=Num(Field(state,"lastActivity"));
      bool active=Visible && !paused && error==null && Convert.ToString(Field(state,"status"))=="running" && activity.HasValue && now-activity.Value<45000;
      if(active!=fastTimer) { if(active)timeBeginPeriod(1);else timeEndPeriod(1);fastTimer=active; }
      int period=!Visible||paused?250:active?8:motion?33:100;
      if(period!=animationPeriod) {animationPeriod=period;animator.Change(0,period);}
      if(seconds-fpsSince>=1) { fps=painted/(seconds-fpsSince); painted=0; fpsSince=seconds; }
      if(seconds-lastSave>=(ShouldSample(hostPid)?1:15)) {bool capture=seconds-lastPreview>=15;SaveEvidence(capture);lastSave=seconds;if(capture)lastPreview=seconds;}
    }; tick.Start();
    animator=new System.Threading.Timer(delegate {
      if(closing || System.Threading.Interlocked.CompareExchange(ref frameQueued,1,0)!=0) return;
      try { BeginInvoke((MethodInvoker)delegate { System.Threading.Interlocked.Exchange(ref frameQueued,0); if(Visible && !paused && !closing) Invalidate(); }); }
      catch { System.Threading.Interlocked.Exchange(ref frameQueued,0); }
    },null,0,100);
    presenceTimer=new System.Threading.Timer(delegate {ScanCodex();},null,0,1500);
    FormClosed += delegate { closing=true;showRequest.Dispose();launcher.Dispose();if(settingsPopup!=null)settingsPopup.Close(); tick.Stop(); animator.Dispose();presenceTimer.Dispose(); if(fastTimer)timeEndPeriod(1); if(feed!=null) { try { if(!feed.HasExited) feed.Kill(); } catch {} feed.Dispose(); } regular.Dispose();small.Dispose();settingsFont.Dispose();tip.Dispose(); };
  }
  static string Quote(string value) { return "\""+value.Replace("\"","\\\"")+"\""; }
  internal static ProcessStartInfo CreateFeedStartInfo(string project,string node,string id,bool followThread=false) {
    ProcessStartInfo start=new ProcessStartInfo(node,Quote(Path.Combine(project,"src","float-feed.mjs"))+" --thread "+id+(followThread?" --follow-thread":""));
    start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;start.RedirectStandardInput=true;start.WorkingDirectory=project;
    start.StandardOutputEncoding=System.Text.Encoding.UTF8;start.StandardErrorEncoding=System.Text.Encoding.UTF8;return start;
  }
  internal static bool TryParseSnapshot(string line,out Dictionary<string,object> parsed) {try{JavaScriptSerializer parser=new JavaScriptSerializer();parser.MaxJsonLength=32*1024*1024;parsed=parser.DeserializeObject(line) as Dictionary<string,object>;return parsed!=null;}catch{parsed=null;return false;}}
  void LogError(string value) { try { File.AppendAllText(Path.Combine(data,"float-error.log"),DateTime.UtcNow.ToString("o")+" "+value+Environment.NewLine); } catch {} }
  void ApplyDpi(uint value) {
    dpi=Math.Max(1,value/96.0); Size=new Size((int)Math.Round(610*Unit),(int)Math.Round(108*Unit));
    regular.Dispose();small.Dispose();settingsFont.Dispose(); regular=new Font("Segoe UI",(float)(16*Unit),FontStyle.Regular,GraphicsUnit.Pixel); small=new Font("Microsoft YaHei UI",(float)(12*Unit),FontStyle.Regular,GraphicsUnit.Pixel);settingsFont=new Font("Microsoft YaHei UI",(float)(14*Unit),FontStyle.Bold,GraphicsUnit.Pixel);
    int radius=(int)Math.Round(16*Unit);
    using(GraphicsPath shape=new GraphicsPath()) { shape.AddArc(0,0,radius,radius,180,90); shape.AddArc(Width-radius-1,0,radius,radius,270,90); shape.AddArc(Width-radius-1,Height-radius-1,radius,radius,0,90); shape.AddArc(0,Height-radius-1,radius,radius,90,90); shape.CloseFigure(); if(Region!=null)Region.Dispose();Region=new Region(shape); }
  }
  protected override void WndProc(ref Message m) {
    if(m.Msg==0x02E0) { ApplyDpi((uint)(m.WParam.ToInt64()&65535)); Invalidate(); }
    base.WndProc(ref m);
  }
  void UpdateFeed() {
    Dictionary<string,object> parsed=null; string failure; lock(gate) { parsed=pending; pending=null; failure=feedFailure; }
    if(parsed==null) { if(failure!=null)error=failure; return; }
    IEnumerable catalog=Field(parsed,"catalog") as IEnumerable;if(catalog!=null) {chatChoices.Clear();foreach(object item in catalog){Dictionary<string,object> row=Obj(item);string id=Convert.ToString(Field(row,"id"));Guid checkedId;if(!Guid.TryParse(id,out checkedId))continue;chatChoices.Add(new ChatChoice{Id=id,Title=Convert.ToString(Field(row,"title")),Modified=Num(Field(row,"modifiedAt"))??0});}catalogRevision++;}
    state=parsed;Dictionary<string,object> scope=Obj(Field(state,"scope"));bool all=Convert.ToString(Field(scope,"mode"))=="all";string scopeKey=Convert.ToString(Field(scope,"mode"))+":"+Convert.ToString(Field(scope,"threadId"))+":"+Convert.ToString(Field(scope,"startedAt"));bool scopeChanged=scopeKey!=lastScopeKey;lastScopeKey=scopeKey;
    if(!paused||scopeChanged) { view=state; BuildCurve();if(scopeChanged)Invalidate(); } error=failure??state["error"] as string;
    string controlError=Field(state,"controlError") as string;if(controlError!=null&&controlError!=lastControlError){lastControlError=controlError;MessageBox.Show(this,controlError,"监控范围设置未生效",MessageBoxButtons.OK,MessageBoxIcon.Information);}if(controlError==null)lastControlError=null;
  }
  string DisplayChartMetric(){return speedMetric=="official-tps"?"official-token-interval-rate":speedMetric=="characters"?Convert.ToString(Field(view,"chartMetric")):"reported-output-tokens-per-second";}
  void BuildCurve() {
    Dictionary<string,object> scope=Obj(Field(view,"scope"));string metric=DisplayChartMetric()+":"+Convert.ToString(Field(scope,"mode"))+":"+Convert.ToString(Field(scope,"threadId"))+":"+Convert.ToString(Field(scope,"startedAt"));if(metric!=lastGraphMetric){lastGraphMetric=metric;dotX=0;smoothScale=1;}
    curve=new List<double[]>(); IEnumerable raw=Field(view,speedMetric=="official-tps"?"officialPoints":speedMetric=="characters"?"points":"reportedPoints") as IEnumerable; if(raw==null) return;
    foreach(object item in raw) { Dictionary<string,object> p=Obj(item); double? rate=Num(Field(p,"rate")), time=Num(Field(p,"time"));
      if(rate.HasValue && time.HasValue) curve.Add(new double[]{time.Value,rate.Value}); }
  }
  internal static double ClampZoom(double value) { return double.IsNaN(value)||double.IsInfinity(value)?1:Math.Max(.6,Math.Min(2,value)); }
  internal static string InstanceName(string directory){using(var hash=System.Security.Cryptography.SHA256.Create())return "Local\\CodexPulse-"+Environment.UserName+"-"+BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(Path.GetFullPath(directory).ToUpperInvariant()))).Replace("-", "").Substring(0,16);}
  internal static bool ShouldSample(uint pid) {return pid!=0;}
  internal static bool IsNativeTopMost(IntPtr window) {return ((IntPtr.Size==8?GetStyle64(window,-20).ToInt64():GetStyle32(window,-20))&8)!=0;}
  internal static IntPtr PreviousWindow(IntPtr window) {return GetWindow(window,3);}
  internal static bool PositionWithoutActivation(IntPtr window,IntPtr after) {return SetWindowPos(window,after,0,0,0,0,0x0213);}
  internal static bool AlignCompanionLayer(IntPtr companion,IntPtr host) {
    if(companion==host||!IsWindow(companion)||!IsWindow(host))return false;
    if(IsNativeTopMost(companion)&&!PositionWithoutActivation(companion,new IntPtr(-2)))return false;
    IntPtr previous=PreviousWindow(host);if(previous==companion)return !IsNativeTopMost(companion);
    // Keep this tool immediately above Codex in the normal window band.
    // A globally topmost predecessor must never promote the tool into that band.
    if(previous!=IntPtr.Zero&&IsNativeTopMost(previous))previous=IntPtr.Zero;
    if(!PositionWithoutActivation(companion,previous))return false;
    if(IsNativeTopMost(companion)) {PositionWithoutActivation(companion,new IntPtr(-2));return false;}
    return PreviousWindow(host)==companion;
  }
  internal static float PlotX(double sampleTime,double now) {return 14+(float)((sampleTime-(now-120000))/120000)*580;}
  static double UnixNow() {return (DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;}
  double? DataAge() {double? observed=Num(Field(view,"observedAt"));double now=paused?(Num(Field(view,"now"))??UnixNow()):UnixNow();return observed.HasValue?(double?)Math.Max(0,(now-observed.Value)/1000):null;}
  internal static double? OfficialTokenRate(Dictionary<string,object> value){
    if(!Convert.ToBoolean(Field(value,"exactCounts")??false))return null;
    string status=Convert.ToString(Field(value,"status"));double? rate=Num(Field(value,status=="live"?"rate":status=="completed"||status=="completion-only"?"responseRate":"unavailable"));
    return rate.HasValue&&!Double.IsNaN(rate.Value)&&!Double.IsInfinity(rate.Value)&&rate.Value>=0?rate:null;
  }
  internal static string OfficialTokenCaption(Dictionary<string,object> value){string status=Convert.ToString(Field(value,"status"));return status=="live"?"官方流区间 TPS":status=="completed"||status=="completion-only"?"本次响应均速":"官方 Token TPS";}
  internal static string OfficialTokenText(Dictionary<string,object> value){double? rate=OfficialTokenRate(value);if(rate.HasValue)return rate.Value.ToString("0.0",CultureInfo.InvariantCulture)+" TPS";string status=Convert.ToString(Field(value,"status"));return status=="select-session"?"请选择会话":status=="counter-error"?"计数异常":status=="disconnected"||status=="unsupported"?"未连接":"待Token上报";}
  internal static bool RetainOfficialHost(Dictionary<string,object> value,double now){string status=Convert.ToString(Field(value,"status"));double? observed=Num(Field(value,"observedAt"));return (status=="completed"||status=="completion-only")&&observed.HasValue&&now>=observed.Value&&now-observed.Value<30000;}
  internal static bool IsCodexPath(string value) { return value!=null && (value.IndexOf("\\WindowsApps\\OpenAI.Codex_",StringComparison.OrdinalIgnoreCase)>=0 || (value.IndexOf("\\OpenAI\\Codex\\",StringComparison.OrdinalIgnoreCase)>=0 && value.IndexOf("\\bin\\",StringComparison.OrdinalIgnoreCase)<0)); }
  internal static string ClientLabel(string client){if(client=="codex")return "Codex";if(client=="claude-code")return "Claude Code";if(client=="antigravity")return "Antigravity";throw new ArgumentException("Unsupported client");}
  internal static string RuntimeDirectory(string project){return Environment.GetEnvironmentVariable("CODEX_PULSE_CLIENT_DATA_DIR")??Environment.GetEnvironmentVariable("CODEX_PULSE_DATA_DIR")??Path.Combine(project,"runtime");}
  internal static bool IsClientPath(string client,string file){
    if(client=="codex")return IsCodexPath(file);if(String.IsNullOrEmpty(file))return false;
    string name=Path.GetFileName(file);
    if(client=="antigravity")return String.Equals(name,"Antigravity.exe",StringComparison.OrdinalIgnoreCase);
    if(client!="claude-code")return false;
    foreach(string allowed in new string[]{"WindowsTerminal.exe","Code.exe","powershell.exe","pwsh.exe","cmd.exe","OpenConsole.exe","conhost.exe"})if(String.Equals(name,allowed,StringComparison.OrdinalIgnoreCase))return true;
    return false;
  }
  static HashSet<uint> ClaudeParentProcesses(uint launcherPid){
    HashSet<uint> result=new HashSet<uint>();Dictionary<uint,uint> parents=new Dictionary<uint,uint>();List<uint> seeds=new List<uint>();
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))return result;
    try{ProcessEntry entry=new ProcessEntry();entry.Size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
      if(Process32First(snapshot,ref entry))do{parents[entry.Pid]=entry.Parent;if(launcherPid!=0?entry.Pid==launcherPid:String.Equals(entry.Name,"claude.exe",StringComparison.OrdinalIgnoreCase))seeds.Add(entry.Pid);}while(Process32Next(snapshot,ref entry));
      foreach(uint seed in seeds){uint current=seed;for(int depth=0;depth<24;depth++){uint parent;if(!parents.TryGetValue(current,out parent)||parent==0||parent==current)break;result.Add(parent);current=parent;}}
    }finally{CloseHandle(snapshot);}return result;
  }
  bool HasClaudeAncestor(uint pid){return claudeParents.Contains(pid);}
  static bool HasClaudeTitle(IntPtr window){System.Text.StringBuilder title=new System.Text.StringBuilder(512);GetWindowText(window,title,title.Capacity);return title.ToString().IndexOf("Claude Code",StringComparison.OrdinalIgnoreCase)>=0;}
  void SetZoom(double value) { zoom=ClampZoom(value);ApplyDpi((uint)Math.Round(dpi*96));Rectangle work=Screen.GetWorkingArea(Location);Location=new Point(Math.Max(work.Left,Math.Min(work.Right-Width,Left)),Math.Max(work.Top,Math.Min(work.Bottom-Height,Top)));Invalidate(); }
  void SaveLayout() { try { Directory.CreateDirectory(data);File.WriteAllText(Path.Combine(data,"float-layout.json"),json.Serialize(new Dictionary<string,object>{{"left",Left},{"top",Top},{"zoom",zoom},{"motion",motion},{"speedMetric",speedMetric},{"launcherSide",launcher.PreferredSide},{"launcherOffset",launcher.Offset}})); } catch(Exception ex) {LogError(ex.Message);} }
  string CompanionCommand(string node){if(client!="codex")return "powershell.exe -NoProfile -ExecutionPolicy Bypass -File "+Quote(Path.Combine(root,"scripts","start-float.ps1"))+" -Client "+client+" -NodePath "+Quote(node)+" -DataDirectory "+Quote(data)+" -ButtonOnly";string launcher=Environment.GetEnvironmentVariable("CODEX_PULSE_LAUNCHER_PATH");return !String.IsNullOrEmpty(launcher)&&File.Exists(launcher)?Quote(launcher):Quote(Application.ExecutablePath)+" "+Quote(root)+" "+Quote(node)+" "+thread;}
  bool CompanionEnabled() { using(RegistryKey key=Registry.CurrentUser.OpenSubKey(RunKey)) return key!=null && String.Equals(Convert.ToString(key.GetValue(RunName)),CompanionCommand(nodePath),StringComparison.OrdinalIgnoreCase); }
  void SetCompanion(bool enabled,string node) {
    try { using(RegistryKey key=Registry.CurrentUser.CreateSubKey(RunKey)) {
      if(enabled) key.SetValue(RunName,CompanionCommand(node));
      else if(String.Equals(Convert.ToString(key.GetValue(RunName)),CompanionCommand(node),StringComparison.OrdinalIgnoreCase))key.DeleteValue(RunName,false);
    } } catch(Exception ex) {LogError(ex.Message);MessageBox.Show("无法保存自动伴随设置："+ex.Message);}
  }
  void ConfigureSize() {
    using(Form dialog=new Form()) {
      dialog.Text="浮条大小";dialog.ClientSize=new Size(300,112);dialog.FormBorderStyle=FormBorderStyle.FixedDialog;dialog.StartPosition=FormStartPosition.CenterScreen;dialog.MaximizeBox=false;dialog.MinimizeBox=false;dialog.TopMost=false;
      Label label=new Label();label.Text="缩放比例（60%–200%）";label.SetBounds(18,16,180,24);dialog.Controls.Add(label);
      NumericUpDown size=new NumericUpDown();size.Minimum=60;size.Maximum=200;size.Value=(decimal)Math.Round(zoom*100);size.SetBounds(205,14,75,28);dialog.Controls.Add(size);
      Button accept=new Button();accept.Text="应用";accept.SetBounds(190,65,90,30);accept.DialogResult=DialogResult.OK;dialog.Controls.Add(accept);dialog.AcceptButton=accept;
      Button cancel=new Button();cancel.Text="取消";cancel.SetBounds(90,65,90,30);cancel.DialogResult=DialogResult.Cancel;dialog.Controls.Add(cancel);dialog.CancelButton=cancel;ThemeDialog(dialog);
      if(dialog.ShowDialog(this)==DialogResult.OK) {SetZoom((double)size.Value/100);SaveLayout();}
    }
  }
  void ShowSettings() {
    if(settingsPopup!=null&&!settingsPopup.IsDisposed){settingsPopup.Close();return;}
    // Deactivation is delivered before a click on the settings button reaches us.
    if(clock.Elapsed.TotalSeconds-settingsClosedAt<.18)return;
    Dictionary<string,object> scope=Obj(Field(state,"scope"));bool all=Convert.ToString(Field(scope,"mode"))=="all";
    PulseSettingsPopup popup=new PulseSettingsPopup(all?"整个 "+clientLabel+" · 本次监控":clientLabel+" · 指定对话",(int)Math.Round(zoom*100),motion,CompanionEnabled(),speedMetric,client=="claude-code");settingsPopup=popup;
    popup.MetricChanged+=delegate(string metric){speedMetric=metric;BuildCurve();SaveLayout();Invalidate();};
    popup.ScopeRequested+=delegate {BeginInvoke((MethodInvoker)ConfigureScope);};
    popup.SizeRequested+=delegate {BeginInvoke((MethodInvoker)ConfigureSize);};
    popup.InfoRequested+=delegate {BeginInvoke((MethodInvoker)ShowMetricInfo);};
    popup.ScaleChanged+=delegate(int percent){SetZoom(percent/100.0);SaveLayout();};
    popup.MotionChanged+=delegate(bool enabled){motion=enabled;SaveLayout();Invalidate();};
    popup.CompanionChanged+=delegate(bool enabled){SetCompanion(enabled,nodePath);popup.SetCompanionChecked(CompanionEnabled());};
    popup.ExitRequested+=delegate {BeginInvoke((MethodInvoker)Close);};
    popup.FormClosed+=delegate {if(settingsPopup==popup)settingsPopup=null;settingsClosedAt=clock.Elapsed.TotalSeconds;settingsHovered=false;Invalidate();};
    Rectangle anchor=RectangleToScreen(new Rectangle((int)(478*Unit),(int)(8*Unit),(int)(70*Unit),(int)(34*Unit)));Rectangle work=Screen.FromControl(this).WorkingArea;
    popup.Bounds=PulseSettingsPopup.Place(popup.Size,anchor,work);popup.Show(this);popup.Bounds=PulseSettingsPopup.Place(popup.Size,anchor,work);
    popup.Activate();
  }
  void ShowMetricInfo(){
    using(Form dialog=new Form()){
      dialog.Text="监控说明";dialog.ClientSize=new Size(460,300);dialog.FormBorderStyle=FormBorderStyle.FixedDialog;dialog.StartPosition=FormStartPosition.CenterScreen;dialog.MaximizeBox=false;dialog.MinimizeBox=false;dialog.ShowInTaskbar=false;
      TextBox info=new TextBox();info.Multiline=true;info.ReadOnly=true;info.BorderStyle=BorderStyle.None;info.ScrollBars=ScrollBars.Vertical;info.TabStop=false;info.SetBounds(20,20,420,225);info.Text="TPS：官方输出 Token 增量 ÷ 观测秒数，可能含推理。属于上报均速，无法精确逐 Token 实时测量。\r\n\r\n字/秒：最近 2 秒收到的可见文字，不含推理和工具执行。\r\n\r\n范围：可选单个对话或本机全局；Token、速度和曲线共同切换。\r\n\r\n操作：拖主体移动，拖右下角缩放。最小化同步隐藏，后台继续采集。\r\n\r\n重新打开：移到 Codex 窗口边缘的标签，再点展开的“监控”按钮。关闭浮条后入口仍保留。";if(client!="codex")info.Text=clientLabel+"：读取本机用量记录。TPS 为最近120秒已上报输出Token/120，含等待时间，不代表瞬时模型速度。\r\n\r\nClaude 使用 claude:stream 启动时支持实时字/秒；Token 仍以上报为准，不提供账户额度。\r\n\r\nClaude Code：Windows 本机会话日志；在终端或 VS Code 使用。窗口无法自动识别时可用 HostPid 指定。\r\n\r\nAntigravity：实验性 SQLite 记录适配；格式不兼容时显示等待或未识别。\r\n\r\n每个客户端的设置与统计起点独立保存。";dialog.Controls.Add(info);
      Button close=new Button();close.Text="知道了";close.SetBounds(340,255,100,30);close.DialogResult=DialogResult.Cancel;dialog.Controls.Add(close);dialog.AcceptButton=close;dialog.CancelButton=close;ThemeDialog(dialog);dialog.ShowDialog(this);
    }
  }
  void SendControl(object request) {try{if(feed==null||feed.HasExited)throw new Exception("采集器未运行");feed.StandardInput.WriteLine(request is string?(string)request:json.Serialize(request));feed.StandardInput.Flush();}catch(Exception ex){MessageBox.Show(this,ex.Message,"无法更新监控范围");}}
  void ConfigureScope() {
    SendControl("list");
    using(Form dialog=new Form()) {
      dialog.Text="监控范围";dialog.ClientSize=new Size(600,470);dialog.FormBorderStyle=FormBorderStyle.FixedDialog;dialog.StartPosition=FormStartPosition.CenterScreen;dialog.MaximizeBox=false;dialog.MinimizeBox=false;dialog.ShowInTaskbar=false;
      RadioButton single=new RadioButton();single.Text="选择某个对话（Token 和速度一起切换）";single.SetBounds(18,16,550,24);dialog.Controls.Add(single);
      RadioButton all=new RadioButton();all.Text="整个 "+clientLabel+"（本次新上报用量）";all.SetBounds(18,45,560,24);dialog.Controls.Add(all);
      Dictionary<string,object> current=Obj(Field(state,"scope"));string selectedId=Convert.ToString(Field(current,"threadId"));if(String.IsNullOrEmpty(selectedId))selectedId=thread;
      all.Checked=Convert.ToString(Field(current,"mode"))=="all";single.Checked=!all.Checked;
      Label info=new Label();info.Text=client=="codex"?"全局统计从开启时刻起新上报的用量；账户额度不相加。文字速度为可连接对话的合计，连接数量会显示在浮条中。":"只统计当前客户端；TPS 为最近120秒上报输出/120。Claude 流式启动另提供字/秒，不提供账户额度。会话列表按ID显示，不读取标题正文。";info.SetBounds(20,78,560,38);dialog.Controls.Add(info);
      TextBox search=new TextBox();search.SetBounds(20,124,455,25);dialog.Controls.Add(search);
      Button refresh=new Button();refresh.Text="刷新列表";refresh.SetBounds(485,122,95,28);refresh.Click+=delegate {SendControl("list");};dialog.Controls.Add(refresh);
      ListBox list=new ListBox();list.SetBounds(20,158,560,218);dialog.Controls.Add(list);
      int seenRevision=-1;EventHandler render=delegate {string filter=search.Text.Trim();list.BeginUpdate();list.Items.Clear();foreach(ChatChoice choice in chatChoices){if(filter.Length>0&&choice.Title.IndexOf(filter,StringComparison.OrdinalIgnoreCase)<0&&choice.Id.IndexOf(filter,StringComparison.OrdinalIgnoreCase)<0)continue;list.Items.Add(choice);if(choice.Id==selectedId)list.SelectedItem=choice;}list.EndUpdate();seenRevision=catalogRevision;};
      list.SelectedIndexChanged+=delegate {ChatChoice choice=list.SelectedItem as ChatChoice;if(choice!=null)selectedId=choice.Id;};search.TextChanged+=render;
      CheckBox reset=new CheckBox();reset.Text="重新开始全局统计（清零本次累计）";reset.SetBounds(20,388,450,24);dialog.Controls.Add(reset);
      EventHandler enable=delegate {search.Enabled=single.Checked;list.Enabled=single.Checked;refresh.Enabled=single.Checked;reset.Enabled=all.Checked;};single.CheckedChanged+=enable;all.CheckedChanged+=enable;enable(null,EventArgs.Empty);render(null,EventArgs.Empty);
      Button apply=new Button();apply.Text="应用";apply.SetBounds(475,426,105,30);apply.Click+=delegate {if(single.Checked&&list.SelectedItem==null){MessageBox.Show(dialog,"请搜索并选择一个对话");return;}SendControl(new Dictionary<string,object>{{"type","scope"},{"mode",all.Checked?"all":"thread"},{"threadId",selectedId},{"resetGlobal",all.Checked&&reset.Checked}});dialog.DialogResult=DialogResult.OK;dialog.Close();};dialog.Controls.Add(apply);dialog.AcceptButton=apply;
      Button cancel=new Button();cancel.Text="取消";cancel.SetBounds(360,426,105,30);cancel.DialogResult=DialogResult.Cancel;dialog.Controls.Add(cancel);dialog.CancelButton=cancel;ThemeDialog(dialog);
      using(Timer refreshTimer=new Timer()){refreshTimer.Interval=300;refreshTimer.Tick+=delegate {if(seenRevision!=catalogRevision)render(null,EventArgs.Empty);};refreshTimer.Start();dialog.ShowDialog(this);refreshTimer.Stop();}
    }
  }
  static void ThemeDialog(Form dialog) {
    dialog.BackColor=Color.FromArgb(18,28,43);dialog.ForeColor=Color.FromArgb(229,241,244);
    foreach(Control control in dialog.Controls){control.ForeColor=dialog.ForeColor;Button button=control as Button;
      if(button!=null){button.FlatStyle=FlatStyle.Flat;button.FlatAppearance.BorderColor=Color.FromArgb(74,127,131);button.BackColor=Color.FromArgb(28,58,67);}
      else if(control is TextBox||control is ListBox||control is NumericUpDown)control.BackColor=Color.FromArgb(28,43,61);
    }
  }
  void SetHostVisibility(bool value) {
    codexVisible=value;
    if(!value&&settingsPopup!=null)settingsPopup.Close();
    if(value && !Visible)Show();else if(!value && Visible)Hide();
    bool sample=ShouldSample(hostPid);
    if(feed!=null && feedSuspended==sample) {
      try {feed.StandardInput.WriteLine(sample?"resume":"pause");feed.StandardInput.Flush();feedSuspended=!sample;} catch(Exception ex) {LogError(ex.Message);}
    }
  }
  void ScanCodex() {
    if(closing || System.Threading.Interlocked.CompareExchange(ref scanBusy,1,0)!=0)return;
    Stopwatch elapsed=Stopwatch.StartNew();HostState found=new HostState();
    try {
      IntPtr known=owner;uint knownPid;GetWindowThreadProcessId(known,out knownPid);
      bool retainedStream=client=="claude-code"&&streamLauncher!=0&&RetainOfficialHost(Obj(Field(state,"officialTokenOutput")),UnixNow());
      if(known!=IntPtr.Zero && IsWindow(known) && ownerProcesses.ContainsKey(knownPid) && (retainedStream||client!="claude-code"&&clock.Elapsed.TotalSeconds-lastDiscovery<(IsIconic(known)?3:15))) {
        Rect bounds;if(GetWindowRect(known,out bounds)) {found.Handle=known;found.Pid=knownPid;found.Bounds=bounds;found.Visible=IsWindowVisible(known)&&!IsIconic(known);found.Probe="validated client window; minimized companion hides but collection continues";return;}
      }
      lastDiscovery=clock.Elapsed.TotalSeconds;
      if(client=="claude-code"&&pinnedHost==0){uint launcher=streamLauncher;if(launcher!=0)try{using(Process process=Process.GetProcessById((int)launcher)){if(process.StartTime.ToUniversalTime().Ticks!=streamLauncherStarted)launcher=0;}}catch{launcher=0;}claudeParents=ClaudeParentProcesses(launcher);}
      Dictionary<uint,string> valid=new Dictionary<uint,string>();
      foreach(string name in client=="codex"?new string[]{"ChatGPT","Codex"}:client=="antigravity"?new string[]{"Antigravity"}:new string[]{"WindowsTerminal","Code","powershell","pwsh","cmd","OpenConsole","conhost"})foreach(Process p in Process.GetProcessesByName(name)) {
        try { string executable; if(!ownerProcesses.TryGetValue((uint)p.Id,out executable))executable=p.MainModule.FileName;
          if(IsClientPath(client,executable)&&(pinnedHost==0||pinnedHost==(uint)p.Id))valid[(uint)p.Id]=executable;
        } catch {} finally {p.Dispose();}
      }
      ownerProcesses=valid;long largest=0;string probe="validPids="+valid.Count+"; ";
      EnumWindows(delegate(IntPtr h,IntPtr ignored) {
        uint pid;GetWindowThreadProcessId(h,out pid);if(!valid.ContainsKey(pid))return true;
        if(client=="claude-code"&&pinnedHost==0&&!HasClaudeAncestor(pid)&&(streamLauncher!=0||!HasClaudeTitle(h)))return true;
        Rect r;if(!GetWindowRect(h,out r))return true;probe+=pid+":"+h.ToInt64()+" "+(r.Right-r.Left)+"x"+(r.Bottom-r.Top)+" visible="+IsWindowVisible(h)+" minimized="+IsIconic(h)+"; ";if(!IsWindowVisible(h))return true;
        if(IsIconic(h)) {if(found.Handle==IntPtr.Zero) {found.Pid=pid;found.Handle=h;found.Bounds=r;found.Visible=false;}return true;}
        long area=(long)(r.Right-r.Left)*(r.Bottom-r.Top);if(area>largest && r.Right-r.Left>=400 && r.Bottom-r.Top>=250) {largest=area;found.Handle=h;found.Pid=pid;found.Visible=!IsIconic(h);found.Bounds=r;}
        return true;
      },IntPtr.Zero);
      if(found.Pid==0&&client!="claude-code")foreach(uint pid in valid.Keys) {if(found.Pid==0 || pid<found.Pid)found.Pid=pid;}
      found.Probe=probe;
    } catch(Exception ex) {LogError(ex.Message);}
    finally {found.ScanMs=elapsed.Elapsed.TotalMilliseconds;lock(gate)pendingHost=found;System.Threading.Interlocked.Exchange(ref scanBusy,0);}
  }
  static Dictionary<string,object> Obj(object value) { return value as Dictionary<string,object>; }
  static double? Num(object value) { if(value==null) return null; try { return Convert.ToDouble(value,CultureInfo.InvariantCulture); } catch { return null; } }
  static object Field(Dictionary<string,object> value,string name) { object v; return value!=null && value.TryGetValue(name,out v) ? v : null; }
  static string Compact(double? value) { if(!value.HasValue) return "—"; double v=value.Value; if(v>=1000000) return (v/1000000).ToString("0.0",CultureInfo.InvariantCulture)+"M"; if(v>=1000) return (v/1000).ToString("0.0",CultureInfo.InvariantCulture)+"k"; return v.ToString("0",CultureInfo.InvariantCulture); }
  static string Remaining(Dictionary<string,object> limits,string key) { double? n=Num(Field(Obj(Field(limits,key)),"usedPercent")); return n.HasValue ? Math.Max(0,100-n.Value).ToString("0",CultureInfo.InvariantCulture)+"%" : "—"; }
  void WriteText(Graphics g,string text,int x,int y,Color color,Font font) {
    GraphicsState saved=g.Save();g.ResetTransform();g.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;
    using(Brush brush=new SolidBrush(color)) g.DrawString(text,font,brush,(float)Math.Round(x*Unit),(float)Math.Round(y*Unit));g.Restore(saved);
  }
  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e);painted++; Graphics g=e.Graphics; g.SmoothingMode=SmoothingMode.AntiAlias;g.ScaleTransform((float)Unit,(float)Unit);
    DrawBackground(g);
    double? age=DataAge(); bool fresh=error==null && age.HasValue && age.Value<=15;
    using(Brush b=new SolidBrush(fresh?mint:muted)) g.FillEllipse(b,13,22,6,6);
    Dictionary<string,object> usage=Obj(Field(view,"usage")), limits=Obj(Field(view,"limits"));
    double? total=Num(Field(usage,"total_tokens"));
    Dictionary<string,object> scope=Obj(Field(view,"scope"));bool all=Convert.ToString(Field(scope,"mode"))=="all";
    bool partial=(all||client!="codex")&&((Num(Field(scope,"readErrors"))??0)>0||(Num(Field(scope,"missingDetails"))??0)>0||(Num(Field(scope,"loading"))??0)>0);
    WriteText(g,all?(partial?"全局本次 Token*":"全局本次 Token"):partial?"单对话 Token*":"单对话 Token",28,7,muted,small); WriteText(g,total.HasValue?total.Value.ToString("N0",CultureInfo.InvariantCulture):"—",28,24,Color.White,regular);
    Dictionary<string,object> live=Obj(Field(view,"liveOutput"));bool liveReady=DisplayChartMetric()=="visible-characters-per-second";
    Dictionary<string,object> official=Obj(Field(view,"officialTokenOutput"));bool tokenMode=speedMetric=="official-tps";
    double? rate=Num(Field(view,"latestRate")),visibleRate=Num(Field(live,"rate")); string speed=liveReady&&visibleRate.HasValue?visibleRate.Value.ToString("0.0",CultureInfo.InvariantCulture)+" 字/s":fresh&&rate.HasValue ? rate.Value.ToString("0.0",CultureInfo.InvariantCulture)+" TPS" : "待上报";
    WriteText(g,tokenMode?OfficialTokenCaption(official):liveReady?"实时可见输出":"输出 TPS · 上报均速",157,7,muted,small); WriteText(g,tokenMode?OfficialTokenText(official):speed,157,24,tokenMode?OfficialTokenRate(official).HasValue?mint:muted:liveReady||fresh?mint:muted,regular);
    bool extraTokens=client=="claude-code"&&!tokenMode;
    WriteText(g,client=="codex"?"5h 剩余":extraTokens?"官方流 TPS":"实时字速",308,7,muted,small); WriteText(g,client=="codex"?Remaining(limits,"primary"):extraTokens?OfficialTokenText(official):Convert.ToBoolean(Field(live,"connected")??false)&&visibleRate.HasValue?visibleRate.Value.ToString("0.0",CultureInfo.InvariantCulture)+" 字/s":"未连接",308,24,Color.White,regular);
    WriteText(g,client=="codex"?"周剩余":"账户额度",423,7,muted,small); WriteText(g,client=="codex"?Remaining(limits,"secondary"):"未提供",423,24,Color.White,regular);
    WriteText(g,paused?"▶":"Ⅱ",555,17,muted,regular); WriteText(g,"×",584,17,muted,regular);
    DrawSettingsButton(g,Unit,settingsHovered,settingsFont);
    DrawSpark(g);
    using(Pen grip=new Pen(Color.FromArgb(130,180,204,222),1)) {g.DrawLine(grip,592,100,602,90);g.DrawLine(grip,597,101,603,95);}
  }
  internal static void DrawSettingsButton(Graphics g,double unit,bool hover,Font labelFont) {
    using(GraphicsPath pill=new GraphicsPath()) {
      pill.AddArc(478,8,14,14,180,90);pill.AddArc(534,8,14,14,270,90);
      pill.AddArc(534,28,14,14,0,90);pill.AddArc(478,28,14,14,90,90);pill.CloseFigure();
      using(Brush fill=new SolidBrush(hover?Color.FromArgb(64,143,130):Color.FromArgb(34,86,83)))g.FillPath(fill,pill);
      using(Pen border=new Pen(hover?Color.FromArgb(193,255,224):Color.FromArgb(119,224,190),hover?1.8f:1.2f))g.DrawPath(border,pill);
    }
    // Vector gear stays sharp at every DPI and avoids missing symbol glyphs.
    using(Pen gear=new Pen(Color.FromArgb(223,255,237),1.7f)) {
      g.DrawEllipse(gear,485,18,12,12);g.DrawEllipse(gear,489,22,4,4);
      for(int i=0;i<8;i++){double angle=i*Math.PI/4;g.DrawLine(gear,491+(float)Math.Cos(angle)*6,24+(float)Math.Sin(angle)*6,491+(float)Math.Cos(angle)*8,24+(float)Math.Sin(angle)*8);}
    }
    GraphicsState saved=g.Save();g.ResetTransform();g.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;
    using(Brush text=new SolidBrush(Color.FromArgb(240,255,248)))g.DrawString("设置",labelFont,text,(float)Math.Round(503*unit),(float)Math.Round(14*unit));
    g.Restore(saved);
  }
  void DrawBackground(Graphics g) {
    DrawBackdrop(g,motion&&!paused?clock.Elapsed.TotalSeconds:0);
  }
  internal static void DrawBackdrop(Graphics g,double t) {
    using(LinearGradientBrush background=new LinearGradientBrush(new Rectangle(0,0,610,108),Color.FromArgb(14,19,39),Color.FromArgb(8,37,42),15f))g.FillRectangle(background,0,0,610,108);
    for(int i=0;i<3;i++) {
      float x=(float)(305+235*Math.Sin(t*.18+i*2.1));float y=(float)(35+20*Math.Cos(t*.24+i));
      using(GraphicsPath ellipse=new GraphicsPath()) {ellipse.AddEllipse(x-180,y-70,360,140);using(PathGradientBrush glow=new PathGradientBrush(ellipse)) {
        glow.CenterColor=i==1?Color.FromArgb(105,141,91,252):Color.FromArgb(85,54,215,219);glow.SurroundColors=new Color[]{Color.Transparent};g.FillPath(glow,ellipse);
      }}
    }
    for(int i=0;i<16;i++) {float x=(float)((i*79.7+t*(3+i%3))%610),y=(float)(7+(i*29.3)%91);int alpha=(int)(22+22*(.5+.5*Math.Sin(t*.8+i)));
      using(Brush star=new SolidBrush(Color.FromArgb(alpha,185,228,255)))g.FillEllipse(star,x,y,i%4==0?2:1,i%4==0?2:1);
    }
    using(Brush glass=new SolidBrush(Color.FromArgb(85,8,17,30)))g.FillRectangle(glass,7,4,539,44);
    using(LinearGradientBrush edge=new LinearGradientBrush(new Rectangle(0,0,610,108),Color.FromArgb(115,87,239,218),Color.FromArgb(120,159,111,247),0f))
    using(Pen border=new Pen(edge,1.2f))g.DrawRectangle(border,1,1,608,106);
    float scan=(float)((t*52)%720)-90;
    using(LinearGradientBrush shine=new LinearGradientBrush(new RectangleF(scan,1,90,1),Color.Transparent,Color.FromArgb(155,200,250,255),0f))g.FillRectangle(shine,scan,1,90,1.5f);
  }
  void DrawSpark(Graphics g) {
    double now=paused?(Num(Field(view,"now"))??0):(DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;
    double range=120000;
    List<PointF> points=new List<PointF>(); double max=1; foreach(double[] p in curve) if(p[0]>=now-range) max=Math.Max(max,p[1]);
    smoothScale=max>smoothScale?max:smoothScale+(max-smoothScale)*.12;
    using(Pen grid=new Pen(Color.FromArgb(40,61,64))) { g.DrawLine(grid,14,62,594,62); g.DrawLine(grid,14,95,594,95); }
    using(Pen grid=new Pen(Color.FromArgb(27,89,135,151))) for(double time=Math.Ceiling((now-range)/30000)*30000;time<=now;time+=30000) {float x=PlotX(time,now);g.DrawLine(grid,x,62,x,95);}
    foreach(double[] p in curve) if(p[0]>=now-range && p[0]<=now) points.Add(new PointF(PlotX(p[0],now),95-(float)(p[1]/smoothScale)*32));
    if(points.Count>1) {
      using(GraphicsPath fill=new GraphicsPath()) {fill.AddLines(points.ToArray());fill.AddLine(points[points.Count-1].X,95,points[0].X,95);fill.CloseFigure();
        using(LinearGradientBrush wash=new LinearGradientBrush(new Rectangle(14,60,580,36),Color.FromArgb(48,83,234,204),Color.Transparent,90f))g.FillPath(wash,fill);
      }
      using(Pen glow=new Pen(Color.FromArgb(35,mint),5f))g.DrawLines(glow,points.ToArray());
      using(Pen pen=new Pen(mint,1.65f))g.DrawLines(pen,points.ToArray());
    }
    if(points.Count>0) {
      PointF p=points[points.Count-1]; if(dotX==0) {dotX=p.X;dotY=p.Y;} dotX+=(p.X-dotX)*.18;dotY+=(p.Y-dotY)*.18;
      bool running=fastTimer; double wave=running&&!paused?(.5+.5*Math.Sin(clock.Elapsed.TotalSeconds*5)):0;
      float radius=(float)(5+wave*3);
      using(Brush halo=new SolidBrush(Color.FromArgb((int)(28+wave*35),mint))) g.FillEllipse(halo,(float)dotX-radius,(float)dotY-radius,radius*2,radius*2);
      using(Brush b=new SolidBrush(mint)) g.FillEllipse(b,(float)dotX-2.7f,(float)dotY-2.7f,5.4f,5.4f);
    }
    if(points.Count==0) WriteText(g,speedMetric=="official-tps"?"等待官方 Token 增量":"等待新的用量记录",205,74,muted,small);
    if(speedMetric=="official-tps"){
      Dictionary<string,object> official=Obj(Field(view,"officialTokenOutput"));string status=Convert.ToString(Field(official,"status"));double? interval=Num(Field(official,"intervalSeconds"));
      string detail=status=="live"?"上报区间 "+(interval??0).ToString("0.00",CultureInfo.InvariantCulture)+"s":status=="completion-only"?"上游仅在结束时报告 Token":status=="completed"?"已结束 · 本次响应均速":status=="select-session"?"官方流 TPS 请选单个会话":"等待生成中的 Token 计数";
      WriteText(g,clientLabel+" · 官方 Token 流",14,48,muted,small);WriteText(g,detail,205,48,muted,small);return;
    }
    bool liveReady=DisplayChartMetric()=="visible-characters-per-second";
    Dictionary<string,object> scope=Obj(Field(view,"scope"));bool all=Convert.ToString(Field(scope,"mode"))=="all";string connection=all?"全局 "+Convert.ToString(Field(scope,"connectedStreams"))+"路"+(Convert.ToString(Field(scope,"discovering"))=="True"?" 发现中":(Num(Field(scope,"unavailableStreams"))??0)>0?" 部分":"")+" · 字/s":"本机事件流 · 字/s";
    double? age=DataAge(); WriteText(g,client!="codex"?clientLabel+(liveReady?" · 实时字/s":speedMetric=="characters"?" · 文字流未连接，回退 TPS":" · 120s 上报 TPS"):liveReady?connection:all?"全局 · 上报 TPS（120s窗口）":speedMetric=="characters"?"文字流断开 · 回退上报 TPS":"输出 TPS · 上报区间均速",14,48,muted,small); WriteText(g,error??(age.HasValue?"用量 "+age.Value.ToString("0")+"s前":"等候回报"),477,48,muted,small);
    if(liveReady) {double? reported=Num(Field(view,"latestRate"));WriteText(g,age.HasValue&&age.Value<=15&&reported.HasValue?(client=="codex"?"上报区间 ":"120s均速 ")+reported.Value.ToString("0.0",CultureInfo.InvariantCulture)+" tok/s":"上报区间：待更新",205,48,muted,small);}
  }
  void SaveEvidence() {SaveEvidence(true);}
  void SaveEvidence(bool capture) {
    try {
      string directory=data; Directory.CreateDirectory(directory);
      Dictionary<string,object> report=new Dictionary<string,object>();
      report["pid"]=Process.GetCurrentProcess().Id;report["pinnedHostPid"]=pinnedHost;report["streamLauncherPid"]=streamLauncher; report["visible"]=Visible; report["ownerProcess"]=ownerName; report["ownerHandle"]=owner.ToInt64();
      report["left"]=Left; report["top"]=Top; report["width"]=Width; report["height"]=Height; report["paused"]=paused;
      report["ownerLeft"]=ownerRect.Left; report["ownerTop"]=ownerRect.Top; report["ownerRight"]=ownerRect.Right; report["ownerBottom"]=ownerRect.Bottom;
      report["ownerVisible"]=owner!=IntPtr.Zero && IsWindowVisible(owner); report["ownerMinimized"]=owner!=IntPtr.Zero && IsIconic(owner);
      report["actualOwnerHandle"]=GetWindow(Handle,4).ToInt64();
      report["dpiScale"]=dpi;report["zoom"]=zoom;report["motion"]=motion;report["hostReady"]=hostReady;report["hostPid"]=hostPid;report["hostScanMs"]=scanMs;report["hostProbe"]=hostProbe;report["feedSuspended"]=feedSuspended; report["renderFps"]=fps;
      double? observed=Num(Field(state,"observedAt"));
      report["version"]="0.11.0";report["client"]=client;report["clientLabel"]=clientLabel;report["capabilities"]=Field(state,"capabilities");report["fastAnimation"]=fastTimer;report["observedAt"]=observed;report["dataAgeSeconds"]=observed.HasValue?(object)Math.Max(0,((DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds-observed.Value)/1000):null;report["lastActivity"]=Field(state,"lastActivity");
      report["placement"]= "codex-window-layer";report["topMost"]=TopMost;report["nativeTopMost"]=IsNativeTopMost(Handle);report["layerAligned"]=layerAligned;
      report["threadId"]=Field(state,"selectedId");report["launchThreadId"]=thread;report["scope"]=Field(state,"scope");report["catalogCount"]=chatChoices.Count;report["usage"]=Field(state,"usage");report["limits"]=Field(state,"limits"); report["checkedAt"]=DateTime.UtcNow.ToString("o"); report["error"]=error;
      report["totalTokens"]=Field(Obj(Field(state,"usage")),"total_tokens"); report["rate"]=Field(state,"latestRate");
      report["displayedTotalTokens"]=Field(Obj(Field(view,"usage")),"total_tokens");
      report["sampledAt"]=Field(state,"now");report["plotSpanSeconds"]=120;report["chartNow"]=paused?Field(view,"now"):(object)UnixNow();report["lastPointPlotX"]=curve.Count>0?(object)PlotX(curve[curve.Count-1][0],UnixNow()):null;
      double? displayedAge=DataAge();report["displayedRate"]=speedMetric=="official-tps"?(object)OfficialTokenRate(Obj(Field(view,"officialTokenOutput"))):DisplayChartMetric()=="visible-characters-per-second"?Field(Obj(Field(view,"liveOutput")),"rate"):error==null&&displayedAge.HasValue&&displayedAge.Value<=15?Field(view,"latestRate"):null;
      report["officialTokenOutput"]=Field(state,"officialTokenOutput");report["officialTokenCaption"]=OfficialTokenCaption(Obj(Field(view,"officialTokenOutput")));
      report["liveOutput"]=Field(state,"liveOutput");report["chartMetric"]=DisplayChartMetric();report["speedMetric"]=speedMetric;
      report["settingsOpen"]=settingsPopup!=null&&!settingsPopup.IsDisposed;
      report["panelExpanded"]=panel.Expanded;report["launcherVisible"]=launcher.Visible;report["launcherHandle"]=launcher.Handle.ToInt64();report["launcherAligned"]=launcherAligned;report["launcherNativeTopMost"]=IsNativeTopMost(launcher.Handle);
      report["launcherLeft"]=launcher.Left;report["launcherTop"]=launcher.Top;report["launcherWidth"]=launcher.Width;report["launcherHeight"]=launcher.Height;
      report["launcherOutside"]=launcher.Outside;report["launcherStowed"]=launcher.Stowed;report["launcherSide"]=launcher.PreferredSide;report["launcherOffset"]=launcher.Offset;
      File.WriteAllText(Path.Combine(directory,"float-status.json"),json.Serialize(report));
      if(capture && Visible) using(Bitmap bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(directory,"float-preview.png")); }
      if(capture && launcher.Visible)using(Bitmap bitmap=new Bitmap(launcher.Width,launcher.Height)){launcher.DrawToBitmap(bitmap,new Rectangle(0,0,bitmap.Width,bitmap.Height));bitmap.Save(Path.Combine(directory,"launcher-preview.png"));}
    } catch {}
  }
  [STAThread] static void Main(string[] args) {
    if(args.Length<3||args.Length>5)return;bool show=false,follow=false;for(int i=3;i<args.Length;i++){if(args[i]=="--show")show=true;else if(args[i]=="--follow-thread")follow=true;else return;} Guid id; if(!Guid.TryParse(args[2],out id)) return;
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { SetProcessDPIAware(); }
    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
    Application.ThreadException += delegate(object sender,System.Threading.ThreadExceptionEventArgs e) { File.AppendAllText(Path.Combine(RuntimeDirectory(args[0]),"float-error.log"),DateTime.UtcNow.ToString("o")+" "+e.Exception.ToString()+Environment.NewLine); };
    AppDomain.CurrentDomain.UnhandledException += delegate(object sender,UnhandledExceptionEventArgs e) { File.AppendAllText(Path.Combine(RuntimeDirectory(args[0]),"float-error.log"),DateTime.UtcNow.ToString("o")+" "+Convert.ToString(e.ExceptionObject)+Environment.NewLine); };
    using(System.Threading.Mutex singleton=new System.Threading.Mutex(false,InstanceName(RuntimeDirectory(args[0])))) {
      bool acquired=false;try {acquired=singleton.WaitOne(0,false);}catch(System.Threading.AbandonedMutexException){acquired=true;}
      if(!acquired){if(show)try{using(var request=System.Threading.EventWaitHandle.OpenExisting(InstanceName(RuntimeDirectory(args[0]))+"-show"))request.Set();}catch{}return;}
      try {Application.Run(new FloatingPulse(args[0],args[1],args[2],show,follow));}finally {singleton.ReleaseMutex();}
    }
  }
}

sealed class PulsePanelState {
  uint lastPid;bool hostVisible,expanded;
  internal PulsePanelState(bool showOnStart){expanded=showOnStart;}
  internal bool Expanded {get{return expanded;}}
  internal bool LauncherVisible {get{return hostVisible;}}
  internal bool PanelVisible {get{return hostVisible&&expanded;}}
  internal void UpdateHost(bool visible,uint pid){if(pid==0||(lastPid!=0&&lastPid!=pid))expanded=false;lastPid=pid;hostVisible=visible&&pid!=0;}
  internal void Toggle(){if(hostVisible)expanded=!expanded;}
  internal void HidePanel(){expanded=false;}
  internal void ShowPanel(){expanded=true;}
}

sealed class PulseLaunchButton : Form {
  internal event Action ToggleRequested,DockPositionChanged;
  float unit=1;bool expanded,hovered,pressed,dragging;Point dragStart,dragOrigin;
  Rectangle hostBounds,workBounds;string preferredSide="right";double offset=.35;DockLayout dock=new DockLayout();
  internal sealed class DockLayout {internal Rectangle Bounds;internal bool Outside,Right;}
  internal string PreferredSide {get{return preferredSide;}}
  internal double Offset {get{return offset;}}
  internal bool Outside {get{return dock.Outside;}}
  internal bool Stowed {get{return !dock.Outside&&!hovered&&!pressed&&!dragging;}}
  protected override bool ShowWithoutActivation {get{return true;}}
  protected override CreateParams CreateParams {get{CreateParams value=base.CreateParams;value.ExStyle|=0x08000000|0x80;return value;}}
  internal PulseLaunchButton(){Text="客户端监控按钮";AccessibleName="打开监控浮条";AccessibleRole=AccessibleRole.PushButton;FormBorderStyle=FormBorderStyle.None;StartPosition=FormStartPosition.Manual;ShowInTaskbar=false;TopMost=false;AutoScaleMode=AutoScaleMode.None;DoubleBuffered=true;BackColor=Color.FromArgb(18,39,47);Cursor=Cursors.Hand;Font=new Font("Microsoft YaHei UI",13,FontStyle.Bold,GraphicsUnit.Pixel);Size=new Size(84,34);}
  internal static double SafeOffset(double value){return Double.IsNaN(value)||Double.IsInfinity(value) ? .35 : Math.Max(0,Math.Min(1,value));}
  internal static DockLayout PlaceDock(Rectangle host,Rectangle work,float unit,string side,double fraction,bool reveal){
    int full=(int)Math.Round(84*unit),height=(int)Math.Round(34*unit),gap=(int)Math.Round(8*unit);
    bool rightFits=host.Right>=work.Left&&host.Right+gap+full<=work.Right,leftFits=host.Left<=work.Right&&host.Left-gap-full>=work.Left;
    bool right=side!="left";if(right&&!rightFits&&leftFits)right=false;else if(!right&&!leftFits&&rightFits)right=true;
    bool outside=right?rightFits:leftFits;int width=outside||reveal?full:(int)Math.Round(12*unit);
    int x=outside?(right?host.Right+gap:host.Left-gap-width):(right?Math.Min(work.Right,host.Right)-width:Math.Max(work.Left,host.Left));
    int y=host.Top+(int)Math.Round(host.Height*SafeOffset(fraction))-height/2;
    return new DockLayout{Outside=outside,Right=right,Bounds=new Rectangle(Math.Max(work.Left,Math.Min(work.Right-width,x)),Math.Max(work.Top,Math.Min(work.Bottom-height,y)),width,height)};
  }
  internal void SetDock(string side,double fraction){preferredSide=side=="left"?"left":"right";offset=SafeOffset(fraction);ApplyPlacement();}
  internal void Sync(Rectangle host,uint dpi,bool shown,bool open){
    float next=Math.Max(1,dpi/96f);if(Math.Abs(next-unit)>.01){unit=next;Font previous=Font;Font=new Font("Microsoft YaHei UI",13*unit,FontStyle.Bold,GraphicsUnit.Pixel);previous.Dispose();}
    hostBounds=host;workBounds=Screen.FromRectangle(host).WorkingArea;
    if(shown){if(!dragging)ApplyPlacement();if(!Visible)Show();}
    else{pressed=false;dragging=false;hovered=false;Capture=false;ApplyPlacement();if(Visible)Hide();}
    SetExpanded(open);
  }
  void ApplyPlacement(){
    if(workBounds.Width<=0||hostBounds.Width<=0)return;
    DockLayout next=PlaceDock(hostBounds,workBounds,unit,preferredSide,offset,hovered||pressed||dragging);
    bool changed=Bounds!=next.Bounds||dock.Outside!=next.Outside||dock.Right!=next.Right;dock=next;
    bool resize=Size!=dock.Bounds.Size;if(Bounds!=dock.Bounds)Bounds=dock.Bounds;if(resize||Region==null)UpdateShape();if(changed)Invalidate();
  }
  void UpdateShape(){float radius=12*unit;using(GraphicsPath path=new GraphicsPath()){path.AddArc(0,0,radius,radius,180,90);path.AddArc(Width-radius,0,radius,radius,270,90);path.AddArc(Width-radius,Height-radius,radius,radius,0,90);path.AddArc(0,Height-radius,radius,radius,90,90);path.CloseFigure();Region old=Region;Region=new Region(path);if(old!=null)old.Dispose();}}
  internal void SetExpanded(bool value){if(value==expanded)return;expanded=value;AccessibleName=value?"收起监控浮条":"打开监控浮条";Invalidate();}
  protected override void OnMouseEnter(EventArgs e){hovered=true;ApplyPlacement();Invalidate();base.OnMouseEnter(e);}
  protected override void OnMouseLeave(EventArgs e){hovered=false;if(!pressed&&!dragging)ApplyPlacement();Invalidate();base.OnMouseLeave(e);}
  protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);if(e.Button==MouseButtons.Left){pressed=ClientRectangle.Contains(e.Location);dragStart=PointToScreen(e.Location);dragOrigin=Location;Capture=pressed;}}
  protected override void OnMouseMove(MouseEventArgs e){base.OnMouseMove(e);if(!pressed)return;Point pointer=PointToScreen(e.Location);int dx=pointer.X-dragStart.X,dy=pointer.Y-dragStart.Y;
    if(!dragging&&Math.Abs(dx)+Math.Abs(dy)<5*unit)return;dragging=true;Cursor=Cursors.SizeAll;
    Location=new Point(Math.Max(workBounds.Left,Math.Min(workBounds.Right-Width,dragOrigin.X+dx)),Math.Max(workBounds.Top,Math.Min(workBounds.Bottom-Height,dragOrigin.Y+dy)));
  }
  protected override void OnMouseUp(MouseEventArgs e){base.OnMouseUp(e);bool moved=dragging,invoke=pressed&&!moved&&e.Button==MouseButtons.Left&&ClientRectangle.Contains(e.Location);pressed=false;dragging=false;Capture=false;Cursor=Cursors.Hand;
    if(moved){preferredSide=Left+Width/2<hostBounds.Left+hostBounds.Width/2?"left":"right";offset=SafeOffset((Top+Height/2.0-hostBounds.Top)/Math.Max(1,hostBounds.Height));hovered=false;ApplyPlacement();if(DockPositionChanged!=null)DockPositionChanged();}
    else{ApplyPlacement();if(invoke&&ToggleRequested!=null)ToggleRequested();}
  }
  protected override void OnPaint(PaintEventArgs e){
    Graphics g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.Clear(hovered?Color.FromArgb(34,83,80):BackColor);g.ScaleTransform(unit,unit);
    float logicalWidth=Width/unit;using(Pen edge=new Pen(Color.FromArgb(134,223,194),1.2f))g.DrawRectangle(edge,.6f,.6f,logicalWidth-1.2f,32.8f);
    if(Stowed){float x=logicalWidth/2;using(Pen mark=new Pen(Color.FromArgb(177,255,221),1.8f)){float direction=dock.Right?-1:1;g.DrawLines(mark,new PointF[]{new PointF(x-direction*1.8f,12),new PointF(x+direction*1.8f,17),new PointF(x-direction*1.8f,22)});}return;}
    PointF[] points={new PointF(10,23),new PointF(17,17),new PointF(22,20),new PointF(30,10)};
    using(Pen curve=new Pen(Color.FromArgb(145,239,202),2.2f)){curve.StartCap=curve.EndCap=LineCap.Round;g.DrawLines(curve,points);}
    using(Brush dot=new SolidBrush(Color.FromArgb(221,255,240)))g.FillEllipse(dot,27.5f,7.5f,5,5);
    g.ResetTransform();g.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;using(Brush text=new SolidBrush(Color.FromArgb(229,255,243)))g.DrawString(expanded?"收起":"监控",Font,text,36*unit,7*unit);
  }
  protected override void Dispose(bool disposing){base.Dispose(disposing);if(disposing)Font.Dispose();}
}

// An ordinary focusable tool window only while the user opens settings. Native
// deactivation dismisses it without mouse hooks, polling, or consuming outside clicks.
sealed class PulseSettingsPopup : Form {
  [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr window);
  internal event Action ScopeRequested,SizeRequested,InfoRequested,ExitRequested;
  internal event Action<int> ScaleChanged;
  internal event Action<bool> MotionChanged,CompanionChanged;
  internal event Action<string> MetricChanged;
  readonly Font heading=new Font("Microsoft YaHei UI",18,FontStyle.Bold,GraphicsUnit.Pixel),caption=new Font("Microsoft YaHei UI",11,FontStyle.Regular,GraphicsUnit.Pixel);
  readonly Font body=new Font("Microsoft YaHei UI",13,FontStyle.Regular,GraphicsUnit.Pixel);
  readonly Dictionary<Control,Rectangle> logicalBounds=new Dictionary<Control,Rectangle>();readonly Dictionary<Control,Font> logicalFonts=new Dictionary<Control,Font>();List<Font> scaledFonts=new List<Font>();
  readonly List<Button> presets=new List<Button>();readonly CheckBox companionToggle;
  readonly Button sizeButton;bool updating;
  internal string DismissReason {get;private set;}
  static readonly Color ink=Color.FromArgb(229,241,244),muted=Color.FromArgb(145,169,182),accent=Color.FromArgb(145,239,202);
  internal PulseSettingsPopup(string scope,int scale,bool motion,bool companion,string metric,bool officialTokenMode=false) {
    Text="Codex Pulse 设置";FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=false;StartPosition=FormStartPosition.Manual;
    AutoScaleMode=AutoScaleMode.None;ClientSize=new Size(338,494);BackColor=Color.FromArgb(18,28,43);ForeColor=ink;
    Font=body;DoubleBuffered=true;
    AddLabel("浮条设置",20,17,230,28,heading,ink);AddLabel("CODEX PULSE",21,49,190,20,caption,muted);
    AddButton("指标说明",222,45,98,25,delegate {Close();if(InfoRequested!=null)InfoRequested();});
    AddButton("×",292,14,28,28,delegate {DismissReason="close-button";Close();});
    AddLabel("监控范围",21,79,180,20,caption,muted);
    AddButton("选择监控范围  ›\n"+scope,18,101,302,49,delegate {Close();if(ScopeRequested!=null)ScopeRequested();});
    AddLabel("浮条大小",21,171,180,22,Font,ink);
    sizeButton=AddButton(scale+"%  ›",237,162,83,33,delegate {Close();if(SizeRequested!=null)SizeRequested();});
    int[] values={75,100,125,150,200};for(int i=0;i<values.Length;i++) {
      int percent=values[i];Button preset=AddButton(percent+"%",18+i*62,204,54,30,delegate {SetScale(percent);if(ScaleChanged!=null)ScaleChanged(percent);});preset.Tag=percent;presets.Add(preset);
    }
    SetScale(scale);
    AddLabel("速度指标",21,247,180,20,caption,muted);
    Button tps=null,characters=null,official=null;Action<string> choose=delegate(string value){if(official!=null)official.BackColor=value=="official-tps"?Color.FromArgb(40,98,89):Color.FromArgb(28,43,61);tps.BackColor=value=="reported-tps"?Color.FromArgb(40,98,89):Color.FromArgb(28,43,61);characters.BackColor=value=="characters"?Color.FromArgb(40,98,89):Color.FromArgb(28,43,61);if(MetricChanged!=null)MetricChanged(value);};
    if(officialTokenMode){official=AddButton("官方流 TPS",18,273,98,30,delegate {choose("official-tps");});tps=AddButton("日志 TPS",122,273,94,30,delegate {choose("reported-tps");});characters=AddButton("字/秒",222,273,98,30,delegate {choose("characters");});}
    else{tps=AddButton("TPS · 上报均速",18,273,147,30,delegate {choose("reported-tps");});characters=AddButton("字/秒 · 实时文字",173,273,147,30,delegate {choose("characters");});}choose(metric);
    CheckBox motionToggle=AddToggle("动态流光背景",18,322,motion);motionToggle.CheckedChanged+=delegate {if(MotionChanged!=null)MotionChanged(motionToggle.Checked);};
    AddLabel("关闭后使用静态背景",44,349,270,17,caption,muted);
    companionToggle=AddToggle("登录后自动伴随当前客户端",18,375,companion);companionToggle.CheckedChanged+=delegate {if(!updating&&CompanionChanged!=null)CompanionChanged(companionToggle.Checked);};
    AddLabel("点击面板外部或按 Esc 收起",21,424,290,20,caption,muted);
    Button exit=AddButton("退出监控及快捷按钮",18,453,302,28,delegate {Close();if(ExitRequested!=null)ExitRequested();});exit.ForeColor=Color.FromArgb(247,173,181);
    foreach(Control control in Controls){logicalBounds[control]=control.Bounds;logicalFonts[control]=control.Font;}
  }
  protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);try{ApplyPopupDpi(GetDpiForWindow(Handle));}catch{ApplyPopupDpi(96);}}
  void ApplyPopupDpi(uint dpi){
    float unit=Math.Max(1,dpi/96f);List<Font> previous=scaledFonts;scaledFonts=new List<Font>();SuspendLayout();
    ClientSize=new Size((int)Math.Round(338*unit),(int)Math.Round(494*unit));
    foreach(Control control in Controls){Rectangle rect;if(!logicalBounds.TryGetValue(control,out rect))continue;Font source=logicalFonts[control],font=new Font(source.FontFamily,source.Size*unit,source.Style,GraphicsUnit.Pixel);scaledFonts.Add(font);control.Font=font;control.SetBounds((int)Math.Round(rect.X*unit),(int)Math.Round(rect.Y*unit),(int)Math.Round(rect.Width*unit),(int)Math.Round(rect.Height*unit));}
    ResumeLayout(false);foreach(Font font in previous)font.Dispose();Invalidate();
  }
  protected override void WndProc(ref Message message){if(message.Msg==0x02E0)ApplyPopupDpi((uint)(message.WParam.ToInt64()&65535));base.WndProc(ref message);}
  internal static Rectangle Place(Size size,Rectangle anchor,Rectangle work) {
    int x=Math.Max(work.Left,Math.Min(work.Right-size.Width,anchor.Right-size.Width));
    int y=anchor.Bottom+8;if(y+size.Height>work.Bottom)y=anchor.Top-size.Height-8;
    return new Rectangle(x,Math.Max(work.Top,Math.Min(work.Bottom-size.Height,y)),size.Width,size.Height);
  }
  void AddLabel(string text,int x,int y,int width,int height,Font font,Color color) {Label label=new Label();label.Text=text;label.Font=font;label.ForeColor=color;label.SetBounds(x,y,width,height);Controls.Add(label);}
  Button AddButton(string text,int x,int y,int width,int height,Action action) {
    Button button=new PulseMenuButton();button.Text=text;button.Font=Font;button.ForeColor=ink;button.SetBounds(x,y,width,height);button.Click+=delegate {action();};Controls.Add(button);return button;
  }
  CheckBox AddToggle(string text,int x,int y,bool enabled) {
    CheckBox toggle=new CheckBox();toggle.Text=text;toggle.Checked=enabled;toggle.FlatStyle=FlatStyle.Flat;toggle.ForeColor=ink;toggle.SetBounds(x,y,302,26);Controls.Add(toggle);return toggle;
  }
  void SetScale(int value) {sizeButton.Text=value+"%  ›";foreach(Button button in presets){bool selected=(int)button.Tag==value;button.BackColor=selected?Color.FromArgb(40,98,89):Color.FromArgb(28,43,61);button.ForeColor=selected?accent:ink;}}
  internal void SetCompanionChecked(bool value){updating=true;companionToggle.Checked=value;updating=false;}
  protected override void OnDeactivate(EventArgs e) {base.OnDeactivate(e);if(!IsDisposed){DismissReason="outside-focus";Close();}}
  protected override bool ProcessCmdKey(ref Message msg,Keys keyData) {if(keyData==Keys.Escape){DismissReason="escape";Close();return true;}return base.ProcessCmdKey(ref msg,keyData);}
  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e);float unit=ClientSize.Width/338f;using(Pen line=new Pen(Color.FromArgb(68,107,125),unit))e.Graphics.DrawRectangle(line,0,0,ClientSize.Width-1,ClientSize.Height-1);
    using(Pen divider=new Pen(Color.FromArgb(40,63,81),unit))e.Graphics.DrawLine(divider,18*unit,412*unit,320*unit,412*unit);
  }
  protected override void Dispose(bool disposing){base.Dispose(disposing);if(disposing){heading.Dispose();caption.Dispose();body.Dispose();foreach(Font font in scaledFonts)font.Dispose();}}
}

sealed class PulseMenuButton : Button {
  bool hovered;
  internal PulseMenuButton(){FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;BackColor=Color.FromArgb(28,43,61);Cursor=Cursors.Hand;}
  protected override void OnMouseEnter(EventArgs e){hovered=true;Invalidate();base.OnMouseEnter(e);}
  protected override void OnMouseLeave(EventArgs e){hovered=false;Invalidate();base.OnMouseLeave(e);}
  protected override void OnPaint(PaintEventArgs e){
    Graphics g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;float radius=Math.Min(12,Height/2f);RectangleF bounds=new RectangleF(.7f,.7f,Width-1.4f,Height-1.4f);
    using(GraphicsPath shape=new GraphicsPath()) {
      shape.AddArc(bounds.Left,bounds.Top,radius,radius,180,90);shape.AddArc(bounds.Right-radius,bounds.Top,radius,radius,270,90);
      shape.AddArc(bounds.Right-radius,bounds.Bottom-radius,radius,radius,0,90);shape.AddArc(bounds.Left,bounds.Bottom-radius,radius,radius,90,90);shape.CloseFigure();
      using(Brush fill=new SolidBrush(hovered?Color.FromArgb(44,75,88):BackColor))g.FillPath(fill,shape);
      using(Pen border=new Pen(Focused?Color.FromArgb(145,239,202):hovered?Color.FromArgb(102,167,170):Color.FromArgb(49,75,94)))g.DrawPath(border,shape);
    }
    TextRenderer.DrawText(g,Text,Font,new Rectangle(6,2,Width-12,Height-4),ForeColor,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix);
  }
}
