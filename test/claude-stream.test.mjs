import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ClaudeTextStream, jsonLines } from '../src/claude-stream.mjs';
import { ClaudeLiveReader, writeStreamState } from '../src/claude-live.mjs';
import { ClientMonitor } from '../src/client-monitor.mjs';
import { runClaudeStream } from '../src/claude-runner.mjs';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const time = 1800000000000;
const event = (uuid, inner, extra = {}) => ({ type: 'stream_event', uuid, session_id: a, event: inner, ...extra });
const start = () => event('start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const delta = (uuid, text, extra) => event(uuid, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, extra);
async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-stream 中文 ')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 })); return root; }
const collect = async stream => { const rows = []; for await (const row of jsonLines(stream, 100)) rows.push(row); return rows; };

test('Claude streaming counts Unicode deltas once, excludes snapshots/thinking/tools/subagents and decays during idle', () => {
  let now = time; const stream = new ClaudeTextStream(a, () => now);
  stream.accept(start());
  assert.equal(stream.accept(delta('one', '你好🙂')), '你好🙂');
  assert.equal(stream.accept(delta('one', '你好🙂')), '', 'replayed UUID is not counted twice');
  assert.equal(stream.accept(delta('foreign', 'PRIVATE', { session_id: b })), '');
  stream.accept({ type: 'assistant', session_id: a, message: { content: [{ type: 'text', text: '你好🙂' }] } });
  stream.accept(delta('subagent', 'PRIVATE', { parent_tool_use_id: 'tool' }));
  stream.accept(event('thinking', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } }));
  stream.accept(event('tool', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', input: 'PRIVATE' } }));
  stream.accept(event('tool-text', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'PRIVATE' } }));
  assert.equal(stream.snapshot().characters, 3);
  assert.ok(!JSON.stringify(stream.snapshot()).includes('PRIVATE'));
  now += 2100; assert.deepEqual(stream.snapshot().buckets, []);
  assert.equal(stream.snapshot().characters, 3);
});

test('bounded JSON lines handles fragmented UTF-8/final lines and rejects invalid or oversized frames', async () => {
  const bytes = Buffer.from('{"text":"你好🙂"}\n{"ok":true}');
  const rows = await collect(Readable.from([bytes.subarray(0, 11), bytes.subarray(11, 13), bytes.subarray(13)]));
  assert.deepEqual(rows, [{ text: '你好🙂' }, { ok: true }]);
  await assert.rejects(collect(Readable.from(['PRIVATE NOT JSON\n'])), /invalid JSON/);
  await assert.rejects(collect(Readable.from(['x'.repeat(101)])), /size limit/);
  await assert.rejects(collect(Readable.from(['x'.repeat(101) + '\n'])), /size limit/);
});

test('live counters connect before logs exist, honor session/global scopes, and fall back after stale heartbeat', async t => {
  const root = await fixture(t), streams = path.join(root, 'data', 'streams'); let now = time;
  const stream = new ClaudeTextStream(a, () => now); stream.accept(start()); stream.accept(delta('first', '你好🙂'));
  await writeStreamState(streams, stream.snapshot());
  const monitor = new ClientMonitor({ client: 'claude-code', home: path.join(root, 'home'), dataDir: path.join(root, 'data'), threadId: a, now: () => now });
  await monitor.initialize(); await monitor.tick();
  const live = monitor.snapshot();
  assert.equal(live.liveOutput.rate, 1.5); assert.equal(live.capabilities.visibleCharacters, true);
  assert.equal(live.chartMetric, 'visible-characters-per-second'); assert.equal(live.usage, null, 'characters must never become official tokens');
  assert.equal(live.error, null); assert.equal(live.scope.streamCoverage, 'available');
  monitor.config.threadId = b; assert.equal(monitor.snapshot().liveOutput.connected, false);
  monitor.config = { mode: 'all', threadId: a, globalStartedAt: time + 100 };
  assert.equal(monitor.snapshot().liveOutput.rate, 0, 'a new global epoch excludes earlier text');
  now += 500; stream.accept(delta('second', 'abcd')); await writeStreamState(streams, stream.snapshot()); await monitor.tick();
  assert.equal(monitor.snapshot().liveOutput.rate, 2);
  now += 3100; await monitor.tick();
  assert.equal(monitor.snapshot().liveOutput.connected, false);
  assert.equal(monitor.snapshot().chartMetric, 'reported-output-tokens-per-second');
});

test('live state rejects oversized or invalid records and does not restore old traffic as current speed', async t => {
  const root = await fixture(t), streams = path.join(root, 'streams'); await mkdir(streams);
  await writeFile(path.join(streams, a + '.json'), 'x'.repeat(9000));
  const reader = new ClaudeLiveReader(streams, () => time); await reader.tick(); assert.equal(reader.errors, 1);
  await writeStreamState(streams, { format: 1, client: 'claude-code', sessionId: a, updatedAt: time + 10000, ended: false, characters: 100, lastTextAt: null, buckets: [] });
  await reader.tick(); assert.equal(reader.errors, 1);
  const stream = new ClaudeTextStream(a, () => time - 4000); stream.accept(start()); stream.accept(delta('old', 'PRIVATE'));
  await writeStreamState(streams, stream.snapshot()); await reader.tick();
  assert.equal(reader.snapshot({ mode: 'all', globalStartedAt: 0 }).connected, false);
});

async function fakeClaude(root, { resultError = false, exitCode = 0, malformed = false, hang = false } = {}) {
  const file = path.join(root, 'fake claude.mjs');
  await writeFile(file, `import {writeFile} from 'node:fs/promises';
const args=process.argv.slice(2);let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if(!args.includes('--include-partial-messages')||args[args.indexOf('--output-format')+1]!=='stream-json'||prompt!=='PRIVATE PROMPT')process.exit(9);
const id=args.find(x=>x.startsWith('--session-id=')||x.startsWith('--resume=')).split('=')[1];
const send=record=>process.stdout.write(JSON.stringify(record)+'\\n');
send({type:'stream_event',uuid:'start',session_id:id,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
send({type:'stream_event',uuid:'delta',session_id:id,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'可见🙂'}}});
send({type:'assistant',session_id:id,message:{content:[{type:'text',text:'可见🙂'}]}});
send({type:'stream_event',uuid:'thinking',session_id:id,event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'PRIVATE THINKING'}}});
${malformed ? "process.stdout.write('PRIVATE INVALID FRAME\\n');" : ''}
${hang ? "setInterval(()=>{},1000);" : `send({type:'result',session_id:id,is_error:${resultError},result:'可见🙂'});process.exitCode=${exitCode};`}
`);
  return file;
}

test('real subprocess runner streams text without replay and exports only counters, preserving error exit codes', async t => {
  const root = await fixture(t), cli = await fakeClaude(root), dataDir = path.join(root, 'data'); let output = '';
  const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  const result = await runClaudeStream({ command: process.execPath, prefix: [cli], prompt: 'PRIVATE PROMPT', sessionId: a, dataDir, stdout });
  assert.equal(result.code, 0); assert.equal(output, '可见🙂'); assert.equal(result.characters, 3);
  const state = await readFile(path.join(dataDir, 'streams', a + '.json'), 'utf8');
  assert.ok(!state.includes('PRIVATE')); assert.ok(!state.includes('可见')); assert.equal(JSON.parse(state).ended, true);
  await fakeClaude(root, { resultError: true });
  assert.equal((await runClaudeStream({ command: process.execPath, prefix: [cli], prompt: 'PRIVATE PROMPT', sessionId: a, dataDir, stdout })).code, 1);
  await fakeClaude(root, { exitCode: 7 });
  assert.equal((await runClaudeStream({ command: process.execPath, prefix: [cli], prompt: 'PRIVATE PROMPT', sessionId: a, dataDir, stdout })).code, 7);
});

test('CLI entry runs an explicit JS installation through Node without shell interpolation', async t => {
  const root = await fixture(t), cli = await fakeClaude(root), dataDir = path.join(root, 'data');
  const script = fileURLToPath(new URL('../scripts/claude-stream.mjs', import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, '--no-monitor', '--claude-path', cli, '--resume', a, 'PRIVATE PROMPT'], {
    env: { ...process.env, CODEX_PULSE_CLIENT_DATA_DIR: dataDir }, timeout: 10000
  });
  assert.equal(stdout.trim(), '可见🙂'); assert.ok(stderr.includes(a));
  assert.deepEqual(await readdir(path.join(dataDir, 'streams')), [a + '.json']);
});

test('malformed streams fail without exporting raw content; cancellation closes the owned child', async t => {
  const root = await fixture(t), cli = await fakeClaude(root, { malformed: true, hang: true }), dataDir = path.join(root, 'data');
  const stdout = new Writable({ write(chunk, encoding, done) { done(); } });
  await assert.rejects(runClaudeStream({ command: process.execPath, prefix: [cli], prompt: 'PRIVATE PROMPT', sessionId: a, dataDir, stdout }), /invalid JSON/);
  await fakeClaude(root, { hang: true });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const result = await runClaudeStream({ command: process.execPath, prefix: [cli], prompt: 'PRIVATE PROMPT', sessionId: b, dataDir, stdout, signal: controller.signal });
    assert.equal(result.code, 130); assert.equal(JSON.parse(await readFile(path.join(dataDir, 'streams', b + '.json'), 'utf8')).ended, true);
  } finally { clearTimeout(timeout); }
});
