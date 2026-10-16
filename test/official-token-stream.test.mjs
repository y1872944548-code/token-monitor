import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Writable } from 'node:stream';
import { OfficialTokenStream, tokenDisplay, validTokenState } from '../src/official-token-stream.mjs';
import { ClaudeTextStream } from '../src/claude-stream.mjs';
import { writeStreamState, ClaudeLiveReader } from '../src/claude-live.mjs';
import { ClientMonitor } from '../src/client-monitor.mjs';
import { runClaudeStream } from '../src/claude-runner.mjs';

const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', time = 1800000000000;
const start = (messageId = 'm1', tokens = 1) => ({ type: 'message_start', message: { id: messageId, usage: { input_tokens: 100, output_tokens: tokens } } });
const usage = (tokens, final = false) => ({ type: 'message_delta', delta: { stop_reason: final ? 'end_turn' : null }, usage: { output_tokens: tokens } });
const wrap = (event, uuid, extra) => ({ type: 'stream_event', event, uuid, session_id: id, ...extra });
const row = (stream, now, ended = false) => ({ sessionId: id, updatedAt: now, ended, officialTokens: stream.snapshot() });
const display = (stream, now) => tokenDisplay([row(stream, now)], { mode: 'thread', threadId: id }, now);
async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-official-token-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('official cumulative usage yields exact observed intervals, independent of visible text and event count', () => {
  let now = time; const stream = new OfficialTokenStream(() => now);
  stream.accept(start()); now += 2000; stream.accept(usage(41));
  assert.equal(display(stream, now).rate, 20); assert.equal(display(stream, now).intervalSeconds, 2);
  assert.equal(display(stream, now).outputTokens, 41); assert.equal(display(stream, now).status, 'live');
  stream.accept(usage(41)); now += 1000; stream.accept(usage(71));
  assert.equal(display(stream, now).rate, 30); assert.equal(stream.snapshot().midstreamUpdates, 2);
  assert.equal(validTokenState(stream.snapshot(), now), true);
  now += 1000; stream.accept(usage(101, true));
  assert.equal(display(stream, now).rate, null); assert.equal(display(stream, now).responseRate, 101 / 4);
  assert.equal(display(stream, now).status, 'completed');
});

test('a completion-only upstream never becomes a real-time TPS even after arbitrarily many text deltas', () => {
  let now = time; const stream = new ClaudeTextStream(id, () => now);
  stream.accept(wrap(start(), 'start'));
  stream.accept(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'block'));
  for (let n = 0; n < 20; n++) { now += 100; stream.accept(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PRIVATE 任意长的🙂文字' } }, 'text' + n)); }
  let value = tokenDisplay([{ ...stream.snapshot(), ended: false }], { mode: 'thread', threadId: id }, now);
  assert.equal(value.rate, null); assert.equal(value.status, 'waiting'); assert.equal(value.outputTokens, 1);
  stream.accept(wrap(usage(41, true), 'final')); stream.accept(wrap({ type: 'message_stop' }, 'stop'));
  value = tokenDisplay([stream.snapshot(true)], { mode: 'thread', threadId: id }, now);
  assert.equal(value.rate, null); assert.equal(value.responseRate, 20.5); assert.equal(value.status, 'completion-only');
  assert.ok(!JSON.stringify(stream.snapshot()).includes('PRIVATE'));
});

test('duplicate events, other sessions and child agents cannot inflate official token speed', () => {
  let now = time; const stream = new ClaudeTextStream(id, () => now);
  stream.accept(wrap(start(), 'start')); now += 1000;
  stream.accept(wrap(usage(51), 'one')); stream.accept(wrap(usage(1000), 'one'));
  stream.accept(wrap(usage(1000), 'child', { parent_tool_use_id: 'tool' }));
  stream.accept(wrap(usage(1000), 'other', { session_id: other }));
  assert.equal(stream.snapshot().officialTokens.outputTokens, 51);
  assert.equal(stream.snapshot().officialTokens.midstreamUpdates, 1);
});

test('counter regressions and malformed counters invalidate a response instead of inventing a reset', () => {
  const invalidStart = new OfficialTokenStream(() => time); invalidStart.accept(start('invalid-start', '1'));
  assert.equal(display(invalidStart, time).status, 'counter-error');
  for (const bad of [20, -1, 2.5, '51', Number.MAX_SAFE_INTEGER + 1]) {
    let now = time; const stream = new OfficialTokenStream(() => now); stream.accept(start());
    now += 1000; stream.accept(usage(51)); now += 1000; stream.accept(usage(bad));
    assert.equal(display(stream, now).status, 'counter-error'); assert.equal(display(stream, now).rate, null);
    stream.accept(usage(100)); assert.equal(display(stream, now).rate, null);
    stream.accept(start('new-response', 0)); now += 1000; stream.accept(usage(10));
    assert.equal(display(stream, now).rate, 10); assert.equal(stream.snapshot().counterErrors, 1);
  }
});

test('stale samples, missing baselines, new messages and global scopes do not reuse another interval', () => {
  let now = time; const stream = new OfficialTokenStream(() => now); stream.accept(start('m1', undefined));
  // An explicit missing baseline must wait for two measured counters.
  stream.reset(); stream.accept({ type: 'message_start', message: { id: 'missing', usage: {} } }); now += 1000; stream.accept(usage(10));
  assert.equal(display(stream, now).rate, null); now += 1000; stream.accept(usage(20)); assert.equal(display(stream, now).rate, 10);
  const saved = row(stream, now); now += 3100;
  assert.equal(tokenDisplay([saved], { mode: 'thread', threadId: id }, now).rate, null);
  assert.equal(tokenDisplay([saved], { mode: 'thread', threadId: other }, now).rate, null);
  assert.equal(tokenDisplay([saved], { mode: 'all', globalStartedAt: time - 1 }, now).status, 'select-session');
  stream.accept(start('m2', 0)); assert.equal(display(stream, now).rate, null);
  now += 1000; stream.accept(usage(5, true)); now += 30001;
  assert.equal(display(stream, now).responseRate, null);
});

test('disk counters, live reader and monitor preserve official TPS without double-counting log usage', async t => {
  const root = await fixture(t), dataDir = path.join(root, 'data'); let now = time;
  const stream = new ClaudeTextStream(id, () => now); stream.accept(wrap(start(), 'start')); now += 2000; stream.accept(wrap(usage(41), 'usage'));
  await writeStreamState(path.join(dataDir, 'streams'), stream.snapshot());
  const monitor = new ClientMonitor({ client: 'claude-code', home: path.join(root, 'empty'), dataDir, threadId: id, now: () => now });
  await monitor.initialize(); await monitor.tick();
  const value = monitor.snapshot();
  assert.equal(value.officialTokenOutput.rate, 20); assert.equal(value.capabilities.streamingTokenRate, true);
  assert.equal(value.usage, null); assert.deepEqual(value.officialPoints, [{ time: now, rate: 20 }]);
  assert.equal(value.liveOutput.rate, 0, 'official tokens also include output without visible text');
  const record = stream.snapshot(); record.officialTokens.interval.to = now + 10000;
  await writeStreamState(path.join(dataDir, 'streams'), record);
  const reader = new ClaudeLiveReader(path.join(dataDir, 'streams'), () => now); await reader.tick(); assert.equal(reader.errors, 1);
});

test('the official SDK basic-response fixture is classified as completion-only, never continuous token telemetry', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/anthropic-usage-order.json', import.meta.url), 'utf8'));
  let now = time; const stream = new OfficialTokenStream(() => now);
  for (const event of fixture.events) {
    stream.accept(event);
    if (event.type !== 'message_delta' && event.type !== 'message_stop') assert.equal(display(stream, now).rate, null);
    now += 100; // Deliberately synthetic timing; the source contains no times.
  }
  assert.equal(display(stream, now).status, 'completion-only'); assert.equal(display(stream, now).rate, null);
  assert.equal(display(stream, now).outputTokens, 6); assert.equal(stream.snapshot().midstreamUpdates, 0);
});

test('spawned CLI streams exact counters to the reader while a request is still running', async t => {
  const root = await fixture(t), script = path.join(root, 'cli.mjs'), dataDir = path.join(root, 'data'), ack = path.join(root, 'continue');
  await writeFile(script, `import {access} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
for await(const chunk of process.stdin){};
const id=process.argv.find(x=>x.startsWith('--session-id=')).split('=')[1];let serial=0;
const send=event=>process.stdout.write(JSON.stringify({type:'stream_event',session_id:id,uuid:String(serial++),event})+'\\n');
send({type:'message_start',message:{id:'synthetic',usage:{output_tokens:1}}});await delay(50);
send({type:'message_delta',delta:{stop_reason:null},usage:{output_tokens:41}});
while(!(await access(${JSON.stringify(ack)}).then(()=>true,()=>false)))await delay(20);
await delay(50);send({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:81}});send({type:'message_stop'});
process.stdout.write(JSON.stringify({type:'result',session_id:id,is_error:false,result:''})+'\\n');
`);
  const controller = new AbortController(); const stdout = new Writable({ write(chunk, encoding, done) { done(); } });
  const run = runClaudeStream({ command: process.execPath, prefix: [script], sessionId: id, prompt: 'test', dataDir, stdout, signal: controller.signal });
  let state;
  try {
    const deadline = Date.now() + 8000;
    do {
      await delay(20); state = await readFile(path.join(dataDir, 'streams', id + '.json'), 'utf8').then(JSON.parse, () => null);
      assert.ok(Date.now() < deadline, 'official usage checkpoint must reach the live reader');
    } while (state?.officialTokens?.outputTokens !== 41);
    const reader = new ClaudeLiveReader(path.join(dataDir, 'streams')); await reader.tick();
    const value = reader.snapshot({ mode: 'thread', threadId: id }).officialTokens;
    const interval = state.officialTokens.interval;
    assert.equal(state.ended, false); assert.equal(value.status, 'live');
    assert.equal(value.rate, 40 / ((interval.to - interval.from) / 1000));
    await writeFile(ack, 'continue'); assert.equal((await run).code, 0);
    const final = JSON.parse(await readFile(path.join(dataDir, 'streams', id + '.json'), 'utf8'));
    assert.equal(final.officialTokens.finalTokens, 81); assert.equal(final.ended, true);
  } finally { controller.abort(); await run.catch(() => {}); }
});
