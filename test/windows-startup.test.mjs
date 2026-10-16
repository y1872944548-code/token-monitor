import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile, cp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { writeStreamState } from '../src/claude-live.mjs';
const exec = promisify(execFile);

test('Windows launch script starts isolated Claude/Antigravity monitors and follows a test host minimize/restore', { skip: process.platform !== 'win32' || process.env.CODEX_PULSE_RUN_NATIVE_STARTUP_TESTS !== '1', timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pulse-windows-startup-')));
  const sourceProject = fileURLToPath(new URL('../', import.meta.url)), project = path.join(root, 'app'), hosts = [], monitors = [], helpers = [];
  // The launcher owns processes by executable path. Use a private copy so even
  // an explicitly enabled local test can never stop the user's real monitors.
  for (const directory of ['src', 'native', 'scripts']) await cp(path.join(sourceProject, directory), path.join(project, directory), { recursive: true });
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = path.join(root, 'Host.cs');
  await writeFile(source, `using System;using System.IO;using System.Diagnostics;using System.Windows.Forms;
static class Host { [STAThread]static void Main(string[] args){Application.EnableVisualStyles();using(Form form=new Form())using(Timer timer=new Timer()){
if(args.Length>1){ProcessStartInfo info=new ProcessStartInfo(args[1],"-e setInterval(()=>{},1000)");info.UseShellExecute=false;info.CreateNoWindow=true;Process child=Process.Start(info);File.WriteAllText(args[0]+".childpid",child.Id.ToString());}
form.Text="Pulse CI test host";form.Width=900;form.Height=650;form.Shown+=delegate{File.WriteAllText(args[0]+".ready","ready");};
string previous="";timer.Interval=100;timer.Tick+=delegate{try{string command=File.Exists(args[0])?File.ReadAllText(args[0]):"";if(command==previous)return;previous=command;if(command=="minimize")form.WindowState=FormWindowState.Minimized;else if(command=="restore"){form.WindowState=FormWindowState.Normal;form.Show();}else if(command=="exit")form.Close();}catch{}};
timer.Start();Application.Run(form);}}}`);
  const cleanup = path.join(root, 'cleanup.ps1');
  await writeFile(cleanup, 'param([int]$MonitorPid,[string]$ExpectedExe)\n$p=Get-Process -Id $MonitorPid -ErrorAction SilentlyContinue\nif($p -and $p.Path -eq $ExpectedExe){& taskkill.exe /PID $MonitorPid /T /F | Out-Null}\n');
  t.after(async () => {
    for (const monitor of [...monitors, ...helpers]) try { await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cleanup, '-MonitorPid', String(monitor.pid), '-ExpectedExe', monitor.exe], { windowsHide: true }); } catch {}
    for (const host of hosts) if (host.exitCode === null) host.kill();
    await delay(300); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const wait = async predicate => { const end = Date.now() + 15000; while (!(await predicate())) { assert.ok(Date.now() < end, 'native startup state timed out'); await delay(100); } };
  const state = async data => { try { return JSON.parse(await readFile(path.join(data, 'float-status.json'), 'utf8')); } catch { return null; } };
  const session = '11111111-1111-4111-8111-111111111111';
  const claudeHome = path.join(root, 'claude'), antigravityHome = path.join(root, 'antigravity');
  const logDir = path.join(claudeHome, 'projects', '-fixture'); await mkdir(logDir, { recursive: true });
  await writeFile(path.join(logDir, session + '.jsonl'), JSON.stringify({ type: 'assistant', sessionId: session, timestamp: new Date().toISOString(), message: { id: 'windows-fixture', usage: { input_tokens: 100, output_tokens: 20 } } }) + '\n');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_PULSE_ANTIGRAVITY_HOME: antigravityHome };
  try {
    for (const client of ['claude-code', 'antigravity']) {
      const hostExe = path.join(root, client === 'claude-code' ? 'Code.exe' : 'Antigravity.exe');
      await exec(compiler, ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/out:' + hostExe, source], { windowsHide: true });
      const control = path.join(root, client + '.control');
      const host = spawn(hostExe, client === 'claude-code' ? [control, process.execPath] : [control], { windowsHide: false, stdio: 'ignore' }); hosts.push(host);
      await wait(async () => (await readFile(control + '.ready', 'utf8').catch(() => '')) === 'ready');
      const launchEnv = { ...env };
      if (client === 'claude-code') {
        const helperPid = Number(await readFile(control + '.childpid', 'utf8')); helpers.push({ pid: helperPid, exe: process.execPath });
        launchEnv.CODEX_PULSE_CLAUDE_LAUNCH_PID = String(helperPid);
      }
      const data = path.join(root, client); await mkdir(data);
      const savedId = client === 'claude-code' ? '22222222-2222-4222-8222-222222222222' : session;
      await writeFile(path.join(data, 'monitor-settings.json'), JSON.stringify({ mode: 'thread', threadId: savedId, globalStartedAt: null }));
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'scripts', 'start-float.ps1'), '-Client', client,
        '-NodePath', process.execPath, '-DataDirectory', data];
      if (client === 'claude-code') args.push('-ThreadId', session, '-FollowThread'); else args.push('-HostPid', String(host.pid));
      await exec('powershell.exe', args, { env: launchEnv, windowsHide: true, timeout: 30000 });
      await wait(async () => { const value = await state(data); return value?.client === client && value.hostPid === host.pid && value.visible && value.scope; });
      const value = await state(data); monitors.push({ pid: value.pid, exe: path.join(project, 'runtime', 'clients', client, 'CodexPulse.exe') });
      assert.equal(value.scope.client, client); assert.equal(value.nativeTopMost, false);
      if (client === 'claude-code') assert.equal(value.usage.total_tokens, 120); else assert.equal(value.usage, null);
      if (client === 'claude-code') {
        await writeFile(control, 'minimize'); await wait(async () => { const value = await state(data); return value?.ownerMinimized && !value.visible && !value.feedSuspended; });
        await writeFile(control, 'restore'); await wait(async () => (await state(data))?.visible);
        let writing = Promise.resolve(), tokenPhase = 'waiting';
        const publish = ended => {
          const now = Date.now();
          const complete = tokenPhase === 'final' || tokenPhase === 'stale', stamp = tokenPhase === 'stale' ? now - 31000 : now;
          const officialTokens = tokenPhase === 'waiting' ? { source: 'anthropic-stream-usage', startedAt: now - 2000, observedAt: now - 2000,
            outputTokens: 1, interval: null, completed: false, finalTokens: null, finalAt: null, midstreamUpdates: 0, counterErrors: 0, invalid: false } : {
            source: 'anthropic-stream-usage', startedAt: stamp - 2000, observedAt: stamp, outputTokens: complete ? 80 : 40,
            interval: { from: stamp - 1000, to: stamp, tokens: 40, final: complete }, completed: complete,
            finalTokens: complete ? 80 : null, finalAt: complete ? stamp : null, midstreamUpdates: 1, counterErrors: 0, invalid: false };
          writing = writing.then(() => writeStreamState(path.join(data, 'streams'), { format: 2, client, sessionId: session, updatedAt: now, ended,
            characters: 20, lastTextAt: ended ? now - 3000 : now, buckets: ended ? [] : [{ time: Math.floor(now / 100) * 100, count: 20 }], officialTokens }));
          return writing;
        };
        await publish(false); const heartbeat = setInterval(() => { void publish(false); }, 200);
        try {
          await wait(async () => { const value = await state(data); return value?.liveOutput?.connected && value.liveOutput.rate === 10 && value.officialTokenOutput?.status === 'waiting'; });
          assert.equal((await state(data)).displayedRate, null, 'text alone must not become exact TPS');
          tokenPhase = 'live'; await publish(false);
          await wait(async () => { const value = await state(data); return value?.officialTokenOutput?.status === 'live' && value.chartMetric === 'official-token-interval-rate' && value.displayedRate === 40; });
          assert.equal((await state(data)).officialTokenCaption, '官方流区间 TPS');
          assert.equal((await state(data)).usage.total_tokens, 120, 'stream characters must not inflate official tokens');
          tokenPhase = 'final'; await publish(true);
          await wait(async () => { const value = await state(data); return value?.officialTokenOutput?.status === 'completed' && value.officialTokenCaption === '本次响应均速' && value.displayedRate === 40; });
        } finally { clearInterval(heartbeat); await writing; tokenPhase = 'stale'; await publish(true); }
        await wait(async () => (await state(data))?.displayedRate === null);
        assert.equal(JSON.parse(await readFile(path.join(data, 'monitor-settings.json'), 'utf8')).threadId, savedId, 'stream launch preserves saved scope');
      }
      // Reopening this client must reuse its own instance and leave the other one alive.
      await exec('powershell.exe', args, { env: launchEnv, windowsHide: true, timeout: 30000 }); assert.equal((await state(data)).pid, value.pid);
    }
    assert.notEqual(monitors[0].pid, monitors[1].pid);
    for (const monitor of monitors) assert.doesNotThrow(() => process.kill(monitor.pid, 0));
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n### Native client startup failure\n\n' + String(error.message).replace(/`/g, '') + '\n');
    throw error;
  }
});
