using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
static class PulseNativeTests {
  [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr window,int message,IntPtr wParam,IntPtr lParam);
  [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  static void Check(bool value,string message) {if(!value)throw new Exception(message);}
  static bool Above(IntPtr upper,IntPtr lower){for(int i=0;i<4096&&lower!=IntPtr.Zero;i++){lower=FloatingPulse.PreviousWindow(lower);if(lower==upper)return true;}return false;}
  static byte[] Render(double scale,double time,string path) {
    using(Bitmap image=new Bitmap((int)Math.Round(610*scale),(int)Math.Round(108*scale))) {
      using(Graphics g=Graphics.FromImage(image)) {g.SmoothingMode=SmoothingMode.AntiAlias;g.ScaleTransform((float)scale,(float)scale);FloatingPulse.DrawBackdrop(g,time);}
      image.Save(path,ImageFormat.Png);return File.ReadAllBytes(path);
    }
  }
  static bool Same(byte[] left,byte[] right) {if(left.Length!=right.Length)return false;for(int i=0;i<left.Length;i++)if(left[i]!=right[i])return false;return true;}
  [STAThread] static void Main(string[] args) {try {Run(args);}catch(Exception error) {try{File.WriteAllText(Path.Combine(args[0],"native-test-error.txt"),error.GetType().Name+" "+error.Message+Environment.NewLine+error.StackTrace,System.Text.Encoding.UTF8);}catch{}Environment.ExitCode=1;}}
  static void Run(string[] args) {
    string output=args[0];Directory.CreateDirectory(output);
    try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{}Application.EnableVisualStyles();
    string unicode="中文标题与表情🙂";string encoded=Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("{\"title\":\""+unicode+"\"}"));
    string node=Environment.GetEnvironmentVariable("CODEX_PULSE_TEST_NODE");
    Check(!String.IsNullOrEmpty(node)&&File.Exists(node),"native tests require CODEX_PULSE_TEST_NODE pointing to the current Node executable");
    ProcessStartInfo feed=FloatingPulse.CreateFeedStartInfo(Path.GetFullPath(output),node,"01a13949-b780-71a2-8863-a7f53db88ead");
    feed.Arguments="-e \"process.stdout.write(Buffer.from('"+encoded+"','base64').toString('utf8'))\"";
    using(Process child=Process.Start(feed)) {string result=child.StandardOutput.ReadToEnd();Check(child.WaitForExit(3000)&&child.ExitCode==0,"UTF8 child fixture must finish");Dictionary<string,object> parsed;Check(FloatingPulse.TryParseSnapshot(result,out parsed)&&Convert.ToString(parsed["title"])==unicode,"Chinese/emoji catalog survives redirected UTF8 round trip");}
    Dictionary<string,object> rejected;Check(!FloatingPulse.TryParseSnapshot("{bad frame",out rejected)&&FloatingPulse.TryParseSnapshot("{\"valid\":true}",out rejected),"bad frame must not poison later valid data");
    Dictionary<string,object> official=new Dictionary<string,object>{{"exactCounts",true},{"status","live"},{"rate",40.0},{"responseRate",null}};
    Check(FloatingPulse.OfficialTokenRate(official)==40&&FloatingPulse.OfficialTokenCaption(official)=="官方流区间 TPS","official midstream counters use the interval TPS label");
    official["status"]="completion-only";official["rate"]=null;official["responseRate"]=25.0;
    Check(FloatingPulse.OfficialTokenRate(official)==25&&FloatingPulse.OfficialTokenCaption(official)=="本次响应均速","completion-only usage must be labeled as response average");
    official["status"]="waiting";Check(!FloatingPulse.OfficialTokenRate(official).HasValue,"stale/completed usage is never reused while awaiting token reports");
    PulsePanelState panel=new PulsePanelState(false);panel.UpdateHost(false,0);Check(!panel.PanelVisible&&!panel.LauncherVisible,"closed Codex hides both surfaces");
    panel.UpdateHost(true,12);Check(panel.LauncherVisible&&!panel.PanelVisible,"opening Codex initially presents a launcher without expanding the panel");
    using(PulseLaunchButton button=new PulseLaunchButton()){
      button.Sync(new Rectangle(0,0,1920,1080),144,false,false);button.ToggleRequested+=delegate {panel.Toggle();button.SetExpanded(panel.Expanded);};
      IntPtr window=button.Handle;
      // The runner's screen can force the initial button into its narrow tab.
      // Click inside the actual control in either layout, not a fixed full-button coordinate.
      int clickX=button.ClientSize.Width/2,clickY=button.ClientSize.Height/2;
      IntPtr point=new IntPtr((clickY<<16)|clickX);
      SendMessage(window,0x0201,new IntPtr(1),point);SendMessage(window,0x0202,IntPtr.Zero,point);
      Check(panel.PanelVisible,"one native launcher click must expand the panel without MCP or model calls");
      panel.HidePanel();Check(panel.LauncherVisible&&!panel.PanelVisible,"closing the panel keeps the launcher");
      SendMessage(window,0x0201,new IntPtr(1),point);SendMessage(window,0x0202,IntPtr.Zero,point);Check(panel.PanelVisible,"the same button must reopen a dismissed panel");
      using(Bitmap image=new Bitmap(button.Width,button.Height)){button.DrawToBitmap(image,new Rectangle(0,0,image.Width,image.Height));image.Save(Path.Combine(output,"launcher-button.png"),ImageFormat.Png);}
      Check(!FloatingPulse.IsNativeTopMost(window),"launcher must remain in the normal window band");
      int changes=0;button.DockPositionChanged+=delegate {changes++;};double before=button.Offset;
      SendMessage(window,0x0201,new IntPtr(1),point);SendMessage(window,0x0200,new IntPtr(1),new IntPtr(((clickY+65)<<16)|clickX));SendMessage(window,0x0202,IntPtr.Zero,point);
      Check(changes==1&&button.Offset!=before&&panel.PanelVisible,"dragging changes remembered docking height without toggling the panel");
      Rectangle screen=Screen.PrimaryScreen.WorkingArea;button.Sync(screen,144,false,true);
      Check(button.Stowed&&button.Width==18,"maximized host stows launcher to a 12 logical pixel edge tab");
      using(Bitmap image=new Bitmap(button.Width,button.Height)){button.DrawToBitmap(image,new Rectangle(0,0,image.Width,image.Height));image.Save(Path.Combine(output,"launcher-stowed.png"),ImageFormat.Png);}
      int right=button.Right;typeof(PulseLaunchButton).GetMethod("OnMouseEnter",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(button,new object[]{EventArgs.Empty});
      Check(!button.Stowed&&button.Width==126&&button.Right==right,"hover reveals a full button without moving the hot edge away from the mouse");
      using(Bitmap image=new Bitmap(button.Width,button.Height)){button.DrawToBitmap(image,new Rectangle(0,0,image.Width,image.Height));image.Save(Path.Combine(output,"launcher-revealed.png"),ImageFormat.Png);}
      typeof(PulseLaunchButton).GetMethod("OnMouseLeave",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(button,new object[]{EventArgs.Empty});
      Check(button.Stowed&&button.Width==18,"leaving the tab restores the narrow state");
    }
    panel.UpdateHost(false,12);Check(!panel.LauncherVisible&&!panel.PanelVisible&&panel.Expanded,"minimize hides both while preserving expansion");
    panel.UpdateHost(true,12);Check(panel.PanelVisible,"restoring Codex restores the previous expansion");
    panel.UpdateHost(false,0);panel.UpdateHost(true,13);Check(panel.LauncherVisible&&!panel.PanelVisible,"new Codex session starts with the button");
    Check(FloatingPulse.ShouldSample(12),"minimized desktop must keep collecting");
    Check(!FloatingPulse.ShouldSample(0),"desktop exit must stop collecting");
    float firstX=FloatingPulse.PlotX(100000,110000),nextX=FloatingPulse.PlotX(100000,111000);
    Check(Math.Abs((firstX-nextX)-580f/120)<.001,"existing data must move left 4.83 logical pixels each second without new records");
    Check(FloatingPulse.ClampZoom(.1)==.6 && FloatingPulse.ClampZoom(9)==2 && FloatingPulse.ClampZoom(double.NaN)==1,"safe scale bounds");
    Check(FloatingPulse.IsCodexPath(@"C:\Program Files\WindowsApps\OpenAI.Codex_26.0\app\ChatGPT.exe"),"desktop path accepted");
    Check(!FloatingPulse.IsCodexPath(@"C:\Other\ChatGPT.exe"),"other apps rejected");
    Check(!FloatingPulse.IsCodexPath(@"C:\Users\example\AppData\Local\OpenAI\Codex\bin\version\codex.exe"),"headless CLI must not keep companion visible after desktop exits");
    Check(FloatingPulse.ClientLabel("claude-code")=="Claude Code"&&FloatingPulse.ClientLabel("antigravity")=="Antigravity","client labels remain explicit");
    Check(FloatingPulse.IsClientPath("claude-code",@"C:\Apps\WindowsTerminal.exe")&&FloatingPulse.IsClientPath("claude-code",@"C:\Apps\Code.exe"),"Claude can attach to terminal or VS Code hosts");
    Check(!FloatingPulse.IsClientPath("claude-code",@"C:\Apps\Antigravity.exe")&&!FloatingPulse.IsClientPath("antigravity",@"C:\Apps\Code.exe"),"host windows stay isolated between clients");
    Check(FloatingPulse.IsClientPath("antigravity",@"C:\Apps\Antigravity.exe"),"Antigravity native host recognized");
    string oldData=Environment.GetEnvironmentVariable("CODEX_PULSE_CLIENT_DATA_DIR");
    try{Environment.SetEnvironmentVariable("CODEX_PULSE_CLIENT_DATA_DIR",output);Check(FloatingPulse.RuntimeDirectory("unrelated")==output,"client-specific data overrides shared runtime");}
    finally{Environment.SetEnvironmentVariable("CODEX_PULSE_CLIENT_DATA_DIR",oldData);}
    Check(FloatingPulse.InstanceName(Path.Combine(output,"claude-code"))!=FloatingPulse.InstanceName(Path.Combine(output,"antigravity")),"client singletons do not share a show request or settings directory");
    // Use only our own hidden test forms: no desktop application is activated or repositioned.
    using(Form host=new Form())using(Form companion=new Form())using(Form other=new Form())using(PulseLaunchButton launcher=new PulseLaunchButton()) {
      companion.ShowInTaskbar=false;companion.TopMost=false;
      IntPtr hostWindow=host.Handle,toolWindow=companion.Handle,otherWindow=other.Handle;
      Check(FloatingPulse.PositionWithoutActivation(toolWindow,IntPtr.Zero),"test tool positioning");
      Check(FloatingPulse.PositionWithoutActivation(hostWindow,IntPtr.Zero),"test host positioning");
      Check(FloatingPulse.PositionWithoutActivation(otherWindow,IntPtr.Zero),"test other app positioning");
      Check(FloatingPulse.AlignCompanionLayer(toolWindow,hostWindow),"tool must align directly above its host");
      Check(FloatingPulse.PreviousWindow(hostWindow)==toolWindow,"host/tool group order");
      Check(Above(otherWindow,toolWindow),"other app must remain above the tool even if Windows inserts another hidden window between them");
      Check(!FloatingPulse.IsNativeTopMost(toolWindow),"tool must not become globally topmost");
      Check(FloatingPulse.PositionWithoutActivation(hostWindow,IntPtr.Zero),"simulate returning to host");
      Check(FloatingPulse.AlignCompanionLayer(toolWindow,hostWindow),"tool follows host forward");
      Check(FloatingPulse.PreviousWindow(hostWindow)==toolWindow&&!FloatingPulse.IsNativeTopMost(toolWindow),"normal-band alignment preserved");
      IntPtr launchWindow=launcher.Handle;Check(FloatingPulse.AlignCompanionLayer(launchWindow,toolWindow),"launcher must sit immediately above its own panel");
      Check(FloatingPulse.PreviousWindow(toolWindow)==launchWindow&&FloatingPulse.PreviousWindow(hostWindow)==toolWindow,"launcher/panel/host order");
      Check(!FloatingPulse.IsNativeTopMost(launchWindow),"launcher layer must never be globally topmost");
      Check(FloatingPulse.PositionWithoutActivation(otherWindow,IntPtr.Zero),"other window returns above the group");
      Check(FloatingPulse.AlignCompanionLayer(toolWindow,hostWindow)&&FloatingPulse.AlignCompanionLayer(launchWindow,toolWindow)&&Above(otherWindow,launchWindow),"other apps must cover both launcher and panel");
    }
    using(PulseSettingsPopup popup=new PulseSettingsPopup("指定对话 · Token 与速度联动",75,true,true,"reported-tps")) {
      IntPtr previewWindow=popup.Handle;popup.PerformAutoScale();popup.PerformLayout();using(Bitmap preview=new Bitmap(popup.Width,popup.Height)){popup.DrawToBitmap(preview,new Rectangle(0,0,popup.Width,popup.Height));foreach(Control control in popup.Controls)control.DrawToBitmap(preview,control.Bounds);preview.Save(Path.Combine(output,"settings-panel.png"),ImageFormat.Png);}
      SendMessage(popup.Handle,0x0006,new IntPtr(1),IntPtr.Zero);SendMessage(popup.Handle,0x0006,IntPtr.Zero,IntPtr.Zero);
      Check(popup.IsDisposed&&popup.DismissReason=="outside-focus","native deactivation must dismiss settings without consuming an outside click");
    }
    using(PulseSettingsPopup popup=new PulseSettingsPopup("整个 Codex · 本次监控",100,false,false,"characters")) {
      object[] keyArgs={Message.Create(popup.Handle,0x0100,new IntPtr(27),IntPtr.Zero),Keys.Escape};
      object handled=typeof(PulseSettingsPopup).GetMethod("ProcessCmdKey",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance).Invoke(popup,keyArgs);
      Check((bool)handled&&popup.IsDisposed&&popup.DismissReason=="escape","Esc must dismiss settings");
    }
    Rectangle work=new Rectangle(-1920,0,1920,1080),anchor=new Rectangle(-80,1010,70,34);Rectangle placement=PulseSettingsPopup.Place(new Size(338,494),anchor,work);
    Check(work.Contains(placement)&&placement.Bottom<anchor.Top,"settings must fit above the anchor near a monitor edge");
    PulseLaunchButton.DockLayout dock=PulseLaunchButton.PlaceDock(new Rectangle(-1920,-8,1920,1088),work,1.5f,"right",.35,false);Check(work.Contains(dock.Bounds)&&dock.Bounds.Width==18&&dock.Bounds.Height==51&&!dock.Outside,"stowed launcher follows a maximized host at 150% DPI on a negative-coordinate screen");
    Rectangle space=new Rectangle(0,0,1920,1080),windowed=new Rectangle(200,80,900,800);PulseLaunchButton.DockLayout outside=PulseLaunchButton.PlaceDock(windowed,space,1.5f,"right",.6,false);
    Check(outside.Outside&&outside.Right&&!outside.Bounds.IntersectsWith(windowed)&&space.Contains(outside.Bounds),"windowed host docks the full button outside the content");
    Rectangle rightWindow=new Rectangle(1450,80,470,800);outside=PulseLaunchButton.PlaceDock(rightWindow,space,1.5f,"right",.6,false);
    Check(outside.Outside&&!outside.Right&&!outside.Bounds.IntersectsWith(rightWindow),"left side is chosen when only it has room outside the host");
    Check(PulseLaunchButton.SafeOffset(Double.NaN)==.35&&PulseLaunchButton.SafeOffset(2)==1,"corrupt persisted docking offsets cannot place the button offscreen");
    byte[] first=Render(1.5,0,Path.Combine(output,"background-t0.png")),second=Render(1.5,2,Path.Combine(output,"background-t2.png"));
    Check(!Same(first,second),"animated background must change pixels");
    Check(Same(first,Render(1.5,0,Path.Combine(output,"background-static.png"))),"motion disabled must stay stable");
    Render(.9,0,Path.Combine(output,"background-60percent-at150dpi.png"));Render(3,0,Path.Combine(output,"background-200percent-at150dpi.png"));
    Console.WriteLine("PASS: outside docking, edge hover reveal/stow, drag without toggle, launcher click/reopen/session/minimize/DPI/layers; settings, UTF8 and rendering. Only our own hidden test windows were used.");
  }
}
