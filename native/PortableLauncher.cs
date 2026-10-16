using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class PortableLauncher {
  static string Quote(string value){return "\""+value.Replace("\"","\\\"")+"\"";}
  [STAThread] static int Main(string[] args){
    string install=AppDomain.CurrentDomain.BaseDirectory,app=Path.Combine(install,"app"),data=Environment.GetEnvironmentVariable("CODEX_PULSE_DATA_DIR")??Path.Combine(install,"data");
    bool check=Array.IndexOf(args,"--check")>=0;
    try{
      if(!Environment.Is64BitOperatingSystem||IntPtr.Size!=8)throw new Exception("需要 Windows 10/11 64位系统。");
      Directory.CreateDirectory(data);string node=Path.Combine(app,"node.exe"),monitor=Path.Combine(app,"CodexPulse.exe"),bootstrap=Path.Combine(app,"src","portable-bootstrap.mjs");
      foreach(string file in new[]{node,monitor,bootstrap})if(!File.Exists(file))throw new Exception("安装文件缺失，请重新运行 Install.cmd。");
      using(Mutex setup=new Mutex(false,"Local\\CodexPulseInstaller-"+Environment.UserName)){
        bool acquired=false;try{acquired=setup.WaitOne(0,false);}catch(AbandonedMutexException){acquired=true;}
        if(!acquired&&!check)throw new Exception("组件正在安装或更新，请稍后再打开。");
        try{
          ProcessStartInfo start=new ProcessStartInfo(node,Quote(bootstrap));start.WorkingDirectory=app;start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;start.StandardOutputEncoding=Encoding.UTF8;start.StandardErrorEncoding=Encoding.UTF8;
          start.EnvironmentVariables["CODEX_PULSE_DATA_DIR"]=data;start.EnvironmentVariables["NODE_NO_WARNINGS"]="1";
          string output,error;using(Process child=Process.Start(start)){
            var readOut=child.StandardOutput.ReadToEndAsync();var readError=child.StandardError.ReadToEndAsync();
            if(!child.WaitForExit(20000)){child.Kill();throw new Exception("本机聊天索引读取超时，请关闭后重试。");}
            output=readOut.Result;error=readError.Result;if(child.ExitCode!=0)throw new Exception("本机初始化失败，请查看 data/launcher-error.log。");
          }
          JavaScriptSerializer json=new JavaScriptSerializer();Dictionary<string,object> result=json.DeserializeObject(output) as Dictionary<string,object>;Guid id;
          if(result==null||!result.ContainsKey("threadId")||!Guid.TryParse(Convert.ToString(result["threadId"]),out id))throw new Exception("本机初始化没有返回有效标识。");
          result["launcherVersion"]="0.10.0";result["checkedAt"]=DateTime.UtcNow.ToString("o");File.WriteAllText(Path.Combine(data,"launch-check.json"),json.Serialize(result),Encoding.UTF8);
          if(check)return 0;
          ProcessStartInfo run=new ProcessStartInfo(monitor,Quote(app)+" "+Quote(node)+" "+id.ToString()+(Array.IndexOf(args,"--show")>=0?" --show":""));run.UseShellExecute=false;run.WorkingDirectory=app;
          run.EnvironmentVariables["CODEX_PULSE_DATA_DIR"]=data;run.EnvironmentVariables["CODEX_PULSE_LAUNCHER_PATH"]=Path.Combine(install,"CodexPulseLauncher.exe");run.EnvironmentVariables["NODE_NO_WARNINGS"]="1";
          Process.Start(run);return 0;
        }finally{if(acquired)setup.ReleaseMutex();}
      }
    }catch(Exception error){
      try{Directory.CreateDirectory(data);File.AppendAllText(Path.Combine(data,"launcher-error.log"),DateTime.UtcNow.ToString("o")+" "+error.GetType().Name+": "+error.Message+Environment.NewLine,Encoding.UTF8);}catch{}
      if(!check)MessageBox.Show(error.Message,"Codex Pulse",MessageBoxButtons.OK,MessageBoxIcon.Information);return 1;
    }
  }
}
