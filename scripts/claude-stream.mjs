import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isId } from '../src/thread-catalog.mjs';
import { clientDataDir } from '../src/clients.mjs';
import { resolveClaude, runClaudeStream, openClaudeMonitor } from '../src/claude-runner.mjs';

const help = `Usage: npm run claude:stream -- [options] "prompt"
  --resume UUID       Continue the named Claude session
  --model NAME        Select a Claude model
  --cwd PATH          Project directory for Claude (default: current directory)
  --claude-path PATH  Native Claude executable, or CLI .js entry
  --no-monitor        Stream in this terminal without opening the Windows float
  --help              Show this help
Prompt may also come from piped stdin. Run in your target project directory.
Uses Claude print mode and its existing login/settings/permission rules.
Visible text is printed normally; only character counters reach the monitor.
`;
try {
  const options = {}, parts = [], args = process.argv.slice(2); let positional = false, noMonitor = false, showHelp = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positional) parts.push(arg);
    else if (arg === '--') positional = true;
    else if (arg === '--help') showHelp = true;
    else if (arg === '--no-monitor') noMonitor = true;
    else if (['--resume', '--model', '--claude-path', '--cwd'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value for ' + arg);
      options[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
    else parts.push(arg);
  }
  if (showHelp) process.stdout.write(help);
  else {
    if (options.resume && !isId(options.resume)) throw new Error('--resume requires a session UUID');
    let prompt = parts.join(' ');
    if (!prompt && !process.stdin.isTTY) {
      const chunks = []; let bytes = 0;
      for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Prompt exceeds 1 MiB'); chunks.push(chunk); }
      prompt = Buffer.concat(chunks).toString('utf8');
    }
    if (!prompt.trim()) throw new Error('Provide a prompt, for example: npm run claude:stream -- "Explain this project"');
    if (Buffer.byteLength(prompt) > 1024 * 1024) throw new Error('Prompt exceeds 1 MiB');
    const resolved = await resolveClaude(options['claude-path']), dataDir = clientDataDir('claude-code');
    const controller = new AbortController(), cancel = () => controller.abort();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const result = await runClaudeStream({ ...resolved, prompt, sessionId: options.resume, resume: !!options.resume, model: options.model, cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(), dataDir, signal: controller.signal,
        onReady: async sessionId => {
          process.stderr.write('Claude session: ' + sessionId + '\n');
          if (process.platform === 'win32' && !noMonitor) try { await openClaudeMonitor(fileURLToPath(new URL('../', import.meta.url)), sessionId, dataDir); }
          catch { process.stderr.write('Monitor could not open. Streaming will continue; run npm run start:claude to retry.\n'); }
        } });
      process.stdout.write('\n'); process.exitCode = result.code;
      if (result.code === 0 && result.characters === 0) process.stderr.write('No incremental visible text was received; live character speed is unavailable for this response.\n');
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
