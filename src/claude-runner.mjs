import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ClaudeTextStream, jsonLines } from './claude-stream.mjs';
import { writeStreamState } from './claude-live.mjs';
import { clientDataDir } from './clients.mjs';

export async function resolveClaude(explicit, env = process.env) {
  const candidates = explicit ? [path.resolve(explicit)] : [
    ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')),
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  ];
  for (const file of candidates) try {
    await access(file, process.platform === 'win32' || /\.(?:mjs|cjs|js)$/i.test(file) ? constants.F_OK : constants.X_OK);
    if (/\.(?:mjs|cjs|js)$/i.test(file)) return { command: process.execPath, prefix: [file] };
    if (process.platform === 'win32' && !/\.exe$/i.test(file)) continue;
    return { command: file, prefix: [] };
  } catch {}
  throw new Error('Claude CLI not found. Install/sign in to Claude Code first, or specify --claude-path (native executable or CLI .js file).');
}

export function claudeArguments({ sessionId, resume = false, model } = {}) {
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
    resume ? '--resume=' + sessionId : '--session-id=' + sessionId];
  if (model) args.push('--model=' + model);
  return args;
}

export async function runClaudeStream({ prompt, sessionId = randomUUID(), resume = false, model, command, prefix = [],
  cwd = process.cwd(), dataDir = clientDataDir('claude-code'), stdout = process.stdout, stderr = process.stderr,
  signal, onReady = async () => {}, env = process.env } = {}) {
  const metrics = new ClaudeTextStream(sessionId), directory = path.join(dataDir, 'streams');
  let child, timer, forceTimer, writing = Promise.resolve(), ioError = null, interrupted = false, resultError = false, sawResult = false;
  const publish = ended => {
    const state = metrics.snapshot(ended);
    writing = writing.then(() => writeStreamState(directory, state)).catch(() => { ioError = new Error('Cannot write Claude live counters'); });
    return writing;
  };
  const stop = () => {
    interrupted = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      if (!forceTimer) forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, 2000).unref();
    }
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await publish(false); if (ioError) throw ioError;
    await onReady(sessionId);
    if (signal?.aborted) return { code: 130, sessionId, characters: 0 };
    child = spawn(command, [...prefix, ...claudeArguments({ sessionId, resume, model })], { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // Observe both spawn errors and exit before consuming stdout; never leave a
    // rejected process promise unhandled while waiting for stream frames.
    const exited = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
    child.stderr.on('data', chunk => stderr.write(chunk));
    timer = setInterval(() => { if (!ioError) void publish(false); else stop(); }, 200);
    for await (const record of jsonLines(child.stdout)) {
      const text = metrics.accept(record);
      if (text) { if (!stdout.write(text)) await new Promise(resolve => stdout.once('drain', resolve)); }
      if (record?.type === 'result' && record.session_id === sessionId) {
        sawResult = true; resultError ||= record.is_error === true;
        // Old/non-streaming CLIs may emit only a final result. Display it, but
        // do not count a completed response as live deltas.
        if (!metrics.characters && typeof record.result === 'string') stdout.write(record.result);
      }
    }
    const exit = await exited;
    if (exit.error) throw new Error('Could not start Claude CLI: ' + (exit.error.code || 'spawn failed'));
    if (ioError) throw ioError;
    return { code: interrupted ? 130 : exit.code || (exit.signal || resultError || !sawResult ? 1 : 0), sessionId, characters: metrics.characters };
  } finally {
    clearInterval(timer); signal?.removeEventListener('abort', stop);
    if (child && child.exitCode === null && child.signalCode === null) {
      stop(); await new Promise(resolve => { child.once('close', resolve); setTimeout(resolve, 2000).unref(); });
      if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    clearTimeout(forceTimer); await publish(true);
  }
}

export async function openClaudeMonitor(project, sessionId, dataDir) {
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'scripts', 'start-float.ps1'),
    '-Client', 'claude-code', '-NodePath', process.execPath, '-ThreadId', sessionId, '-FollowThread', '-DataDirectory', dataDir], { windowsHide: true, timeout: 30000 });
}
