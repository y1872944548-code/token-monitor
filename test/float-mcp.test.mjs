import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sampleFloat } from '../src/float-snapshot.mjs';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pulse-float-mcp-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'data');
  await mkdir(dataDir);
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, rollout_path TEXT, updated_at INTEGER, created_at INTEGER, archived INTEGER)');
    for (const [id, total, archived] of [[a, 120, 1], [b, 800, 0]]) {
      const root = path.join(home, archived ? 'archived_sessions' : 'sessions', '2020', '01', '01');
      await mkdir(root, { recursive: true });
      const file = path.join(root, `rollout-${id}.jsonl`);
      await writeFile(file, JSON.stringify({ type: 'token_usage_record', timestamp: '2020-01-01T00:00:00Z', payload: { thread_token_usage: { total_tokens: total, output_tokens: 20 } } }) + '\n');
      db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(id, 'Synthetic fixture', file, archived ? 1 : 2, 1, archived);
    }
  } finally { db.close(); }
  await writeFile(path.join(dataDir, 'monitor-settings.json'), JSON.stringify({ mode: 'thread', threadId: a }));
  return { home, dataDir };
}

test('float snapshot uses saved scope and indexed archived logs beyond recent date folders', async t => {
  const { home, dataDir } = await fixture(t);
  const saved = await sampleFloat({ codexHome: home, dataDir });
  assert.equal(saved.selectedId, a);
  assert.equal(saved.usage.total_tokens, 120);
  const explicit = await sampleFloat({ threadId: b, codexHome: home, dataDir });
  assert.equal(explicit.selectedId, b);
  assert.equal(explicit.usage.total_tokens, 800);
});

test('float snapshot honors the data directory and rejects stale, future or mismatched window state', async t => {
  const { home, dataDir } = await fixture(t);
  const now = Date.now();
  const file = path.join(dataDir, 'float-status.json');
  const window = { checkedAt: new Date(now).toISOString(), threadId: null, scope: { mode: 'all' }, usage: { total_tokens: 999 }, limits: null, observedAt: now, dataAgeSeconds: 0, rate: 5 };
  await writeFile(file, JSON.stringify(window));
  const all = await sampleFloat({ codexHome: home, dataDir, now });
  assert.equal(all.scope.mode, 'all');
  assert.equal(all.selectedId, null);
  assert.equal(all.usage.total_tokens, 999);
  const explicit = await sampleFloat({ threadId: b, codexHome: home, dataDir, now });
  assert.equal(explicit.selectedId, b);
  assert.equal(explicit.usage.total_tokens, 800);
  for (const offset of [-6000, 1000]) {
    await writeFile(file, JSON.stringify({ ...window, checkedAt: new Date(now + offset).toISOString() }));
    const value = await sampleFloat({ codexHome: home, dataDir, now });
    assert.equal(value.window, null);
    assert.equal(value.usage.total_tokens, 120);
  }
});

test('current float MCP entry serves actual fixture metrics over stdio', async t => {
  const { home, dataDir } = await fixture(t);
  const client = new Client({ name: 'float-integration', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/float-mcp.mjs', import.meta.url))],
    env: { ...process.env, CODEX_HOME: home, CODEX_PULSE_DATA_DIR: dataDir, CODEX_PULSE_SETTINGS_FILE: path.join(dataDir, 'monitor-settings.json') }
  }));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['pulse_open', 'pulse_snapshot']);
  const response = await client.callTool({ name: 'pulse_snapshot', arguments: { threadId: b } });
  assert.ok(!response.isError);
  assert.equal(response.structuredContent.usage.total_tokens, 800);
  assert.equal(response.structuredContent.selectedId, b);
  assert.equal(response.structuredContent.presentation, 'desktop-float');
  if (process.platform !== 'win32') {
    const opened = await client.callTool({ name: 'pulse_open', arguments: {} });
    assert.equal(opened.isError, true);
    assert.match(opened.content[0].text, /Windows/);
  }
});
