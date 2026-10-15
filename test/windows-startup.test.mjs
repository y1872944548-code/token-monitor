import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile);

test('Windows launch script starts isolated Claude/Antigravity monitors and follows a test host minimize/restore', { skip: process.platform !== 'win32' || process.env.CODEX_PULSE_RUN_NATIVE_STARTUP_TESTS !== '1', timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-windows-startup-'));
  const sourceProject = fileURLToPath(new URL('../', import.meta.url)), project = path.join(root, 'app'), hosts = [], monitors = [];
  // The launcher owns processes by executable path. Use a private copy so even
  // an explicitly enabled local test can never stop the user's real monitors.
  for (const directory of ['src', 'native', 'scripts']) await cp(path.join(sourceProject, directory), path.join(project, directory), { recursive: true });
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = path.join(root, 'Host.cs');
  await writeFile(source, `using System;using System.IO;using System.Windows.Forms;
static class Host { [STAThread]static void Main(string[] args){Application.EnableVisualStyles();using(Form form=new Form())using(Timer timer=new Timer()){
form.Text="Pulse CI test host";form.Width=900;form.Height=650;form.Shown+=delegate{File.WriteAllText(args[0]+".ready","ready");};
string previous="";timer.Interval=100;timer.Tick+=delegate{try{string command=File.Exists(args[0])?File.ReadAllText(args[0]):"";if(command==previous)return;previous=command;if(command=="minimize")form.WindowState=FormWindowState.Minimized;else if(command=="restore"){form.WindowState=FormWindowState.Normal;form.Show();}else if(command=="exit")form.Close();}catch{}};
timer.Start();Application.Run(form);}}}`);
  const cleanup = path.join(root, 'cleanup.ps1');
  await writeFile(cleanup, 'param([int]$MonitorPid,[string]$ExpectedExe)\n$p=Get-Process -Id $MonitorPid -ErrorAction SilentlyContinue\nif($p -and $p.Path -eq $ExpectedExe){Stop-Process -Id $MonitorPid}\n');
  t.after(async () => {
    for (const monitor of monitors) try { await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cleanup, '-MonitorPid', String(monitor.pid), '-ExpectedExe', monitor.exe], { windowsHide: true }); } catch {}
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
      const host = spawn(hostExe, [control], { windowsHide: false, stdio: 'ignore' }); hosts.push(host);
      await wait(async () => (await readFile(control + '.ready', 'utf8').catch(() => '')) === 'ready');
      const data = path.join(root, client); await mkdir(data);
      await writeFile(path.join(data, 'monitor-settings.json'), JSON.stringify({ mode: 'thread', threadId: session, globalStartedAt: null }));
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'scripts', 'start-float.ps1'), '-Client', client,
        '-NodePath', process.execPath, '-HostPid', String(host.pid), '-DataDirectory', data];
      await exec('powershell.exe', args, { env, windowsHide: true, timeout: 30000 });
      await wait(async () => { const value = await state(data); return value?.client === client && value.hostPid === host.pid && value.visible && value.scope; });
      const value = await state(data); monitors.push({ pid: value.pid, exe: path.join(project, 'runtime', 'clients', client, 'CodexPulse.exe') });
      assert.equal(value.scope.client, client); assert.equal(value.nativeTopMost, false);
      if (client === 'claude-code') assert.equal(value.usage.total_tokens, 120); else assert.equal(value.usage, null);
      if (client === 'claude-code') {
        await writeFile(control, 'minimize'); await wait(async () => { const value = await state(data); return value?.ownerMinimized && !value.visible && !value.feedSuspended; });
        await writeFile(control, 'restore'); await wait(async () => (await state(data))?.visible);
      }
      // Reopening this client must reuse its own instance and leave the other one alive.
      await exec('powershell.exe', args, { env, windowsHide: true, timeout: 30000 }); assert.equal((await state(data)).pid, value.pid);
    }
    assert.notEqual(monitors[0].pid, monitors[1].pid);
    for (const monitor of monitors) assert.doesNotThrow(() => process.kill(monitor.pid, 0));
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n### Native client startup failure\n\n' + String(error.message).replace(/`/g, '') + '\n');
    throw error;
  }
});
