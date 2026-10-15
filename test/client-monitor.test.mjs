import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ClientMonitor, parseClaudeRecord } from '../src/client-monitor.mjs';
import { parseAntigravityRecord } from '../src/antigravity-record.mjs';
import { clientDataDir } from '../src/clients.mjs';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const time = 1800000000000;
const event = (id, sessionId = a, output = 20, at = time) => ({ type: 'assistant', sessionId, timestamp: new Date(at).toISOString(),
  message: { id, content: [{ type: 'text', text: 'PRIVATE MESSAGE BODY' }], usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: output } } });
async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-clients-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function varint(value) { let n = BigInt(value); const bytes = []; do { let byte = Number(n & 127n); n >>= 7n; bytes.push(byte | (n ? 128 : 0)); } while (n); return Buffer.from(bytes); }
function field(number, value) { return Buffer.concat([varint(number * 8 + (Buffer.isBuffer(value) ? 2 : 0)), ...(Buffer.isBuffer(value) ? [varint(value.length), value] : [varint(value)])]); }
function metadata({ stamp = true, out = 30, modelId = 1298, response = 'synthetic-response' } = {}) {
  const usage = Buffer.concat([field(1, modelId), field(2, 100), field(3, out), field(5, 50), field(9, 10), field(10, 20), field(11, Buffer.from(response))]);
  const generation = stamp ? field(9, field(4, Buffer.concat([field(1, time / 1000), field(2, 0)]))) : Buffer.alloc(0);
  return field(1, Buffer.concat([field(4, usage), generation]));
}

test('Claude usage counts cache buckets once and never saves message content', () => {
  const row = parseClaudeRecord(event('m1'), a);
  assert.equal(row.usage.input_tokens, 160); assert.equal(row.usage.total_tokens, 180);
  assert.equal(row.usage.reasoning_output_tokens, null);
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  assert.equal(parseClaudeRecord({ type: 'user', message: { content: 'PRIVATE' } }, a), null);
  assert.equal(parseClaudeRecord(event('m1', b), a), null);
  const bad = event('bad'); bad.message.usage.output_tokens = '20'; assert.throws(() => parseClaudeRecord(bad, a));
});

test('Claude incremental feed deduplicates content blocks, waits for complete lines and handles pause/truncation', async t => {
  const home = await fixture(t), dir = path.join(home, 'projects', '-project'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, a + '.jsonl'); await writeFile(file, JSON.stringify(event('m1')) + '\n');
  let now = time + 1000;
  const monitor = new ClientMonitor({ client: 'claude-code', home, threadId: a, now: () => now }); await monitor.initialize(); await monitor.tick();
  assert.equal(monitor.snapshot().usage.total_tokens, 180);
  await appendFile(file, JSON.stringify(event('m1', a, 20, time + 5000)) + '\n'); await monitor.tick();
  assert.equal(monitor.snapshot().observedAt, time, 'replayed identical usage must not refresh its observation time');
  const next = JSON.stringify(event('m1', a, 30, time + 6000)); now = time + 7000;
  await appendFile(file, next.slice(0, 40)); await monitor.tick(); assert.equal(monitor.snapshot().usage.total_tokens, 180);
  await appendFile(file, next.slice(40) + '\n'); await monitor.tick(); assert.equal(monitor.snapshot().usage.total_tokens, 190);
  monitor.pause(); await appendFile(file, JSON.stringify(event('m2', a, 5, time + 7000)) + '\n'); await monitor.tick(); assert.equal(monitor.snapshot().usage.total_tokens, 190);
  monitor.resume(); await monitor.tick(); assert.equal(monitor.snapshot().usage.total_tokens, 355);
  await writeFile(file, JSON.stringify(event('m3', a, 1)) + '\n'); await monitor.tick(); assert.equal(monitor.snapshot().usage.total_tokens, 161);
  assert.ok(!JSON.stringify(monitor.snapshot()).includes('PRIVATE'));
});

test('client global scope has an independent saved epoch, deduplicates Claude forks and isolates selected sessions', async t => {
  const home = await fixture(t), dir = path.join(home, 'projects', '-project'); await mkdir(dir, { recursive: true });
  for (const id of [a, b]) await writeFile(path.join(dir, id + '.jsonl'), JSON.stringify(event('shared', id)) + '\n');
  const settingsFile = path.join(home, 'settings.json');
  const monitor = new ClientMonitor({ client: 'claude-code', home, threadId: a, settingsFile, now: () => time + 10000 });
  await monitor.initialize(); await monitor.select({ mode: 'all', threadId: a }); monitor.config.globalStartedAt = time - 1; await monitor.persist(monitor.config); await monitor.tick();
  assert.equal(monitor.snapshot().usage.total_tokens, 180); assert.equal(monitor.snapshot().selectedId, null);
  assert.equal(monitor.snapshot().latestRate, 20 / 120);
  await monitor.select({ mode: 'thread', threadId: b }); await monitor.tick(); assert.equal(monitor.snapshot().selectedId, b);
  await monitor.select({ mode: 'all' }); assert.equal(monitor.config.globalStartedAt, time - 1);
  const resumed = new ClientMonitor({ client: 'claude-code', home, settingsFile }); await resumed.initialize(); assert.equal(resumed.config.globalStartedAt, time - 1);
  assert.notEqual(clientDataDir('claude-code', home), clientDataDir('antigravity', home));
});

test('Antigravity metadata uses aggregate output, excludes model IDs and rejects unknown timestamps/framing', () => {
  const row = parseAntigravityRecord(metadata());
  assert.equal(row.usage.input_tokens, 150); assert.equal(row.usage.output_tokens, 30); assert.equal(row.usage.total_tokens, 180);
  assert.equal(row.usage.reasoning_output_tokens, null); assert.equal(row.time, time);
  assert.throws(() => parseAntigravityRecord(metadata({ stamp: false })));
  assert.throws(() => parseAntigravityRecord(metadata({ out: 99 })));
  assert.throws(() => parseAntigravityRecord(Buffer.from([10, 255])));
  assert.throws(() => parseAntigravityRecord(Buffer.alloc(1024 * 1024 + 1)));
});

test('Antigravity SQLite reader handles new generations and copies without modifying the source database', async t => {
  const home = await fixture(t), dbFile = path.join(home, a + '.db');
  const db = new DatabaseSync(dbFile);
  try {
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)'); db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, metadata());
  const before = await readFile(dbFile);
  const monitor = new ClientMonitor({ client: 'antigravity', home, threadId: a, now: () => time + 1000 }); await monitor.initialize(); await monitor.tick();
  assert.equal(monitor.snapshot().usage.total_tokens, 180); assert.equal(monitor.snapshot().capabilities.experimental, true);
  assert.deepEqual(await readFile(dbFile), before);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(2, metadata());
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(3, metadata({ response: 'second' })); await monitor.tick();
  assert.equal(monitor.snapshot().usage.total_tokens, 360);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(4, metadata({ stamp: false, response: 'unsupported' })); await monitor.tick();
  assert.equal(monitor.snapshot().scope.coverage, 'partial'); assert.equal(monitor.snapshot().usage.total_tokens, 360);
  } finally { db.close(); }
});

test('empty or unsupported Antigravity history remains unavailable instead of fabricated zero usage', async t => {
  const home = await fixture(t); const monitor = new ClientMonitor({ client: 'antigravity', home, now: () => time }); await monitor.initialize(); await monitor.tick();
  assert.equal(monitor.snapshot().usage, null); assert.equal(monitor.snapshot().latestRate, null);
  const db = new DatabaseSync(path.join(home, a + '.db')); db.exec('CREATE TABLE gen_metadata (wrong TEXT)'); db.close();
  await monitor.discover(); await monitor.tick(); assert.equal(monitor.snapshot().usage, null); assert.equal(monitor.snapshot().scope.readErrors, 1);
});

test('Claude discovery rejects session symlinks escaping the approved project root', { skip: process.platform === 'win32' }, async t => {
  const home = await fixture(t), outside = await fixture(t), dir = path.join(home, 'projects', '-project'); await mkdir(dir, { recursive: true });
  const external = path.join(outside, a + '.jsonl'); await writeFile(external, JSON.stringify(event('external')) + '\n'); await symlink(external, path.join(dir, a + '.jsonl'));
  const monitor = new ClientMonitor({ client: 'claude-code', home }); await monitor.initialize(); await monitor.tick(); assert.equal(monitor.snapshot().usage, null);
});
