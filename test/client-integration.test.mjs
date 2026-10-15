import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const event = (sessionId, id, output) => JSON.stringify({ type: 'assistant', sessionId, timestamp: new Date().toISOString(), message: {
  id, content: [{ type: 'text', text: 'PRIVATE CHAT BODY' }], usage: { input_tokens: 100, output_tokens: output }
} }) + '\n';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-client-integration-')); t.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'claude', 'projects', '-test'); await mkdir(projects, { recursive: true });
  await writeFile(path.join(projects, a + '.jsonl'), event(a, 'one', 10)); await writeFile(path.join(projects, b + '.jsonl'), event(b, 'two', 30));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_PULSE_ANTIGRAVITY_HOME: path.join(root, 'antigravity'), CODEX_HOME: path.join(root, 'codex'), CODEX_PULSE_DATA_DIR: path.join(root, 'data') };
  for (const key of ['CODEX_PULSE_CLIENT', 'CODEX_PULSE_CLIENT_DATA_DIR', 'CODEX_PULSE_SETTINGS_FILE']) delete env[key];
  return { root, projects, env };
}

test('stdio MCP selects Claude and Antigravity while default Codex remains isolated', async t => {
  const { env } = await fixture(t);
  const client = new Client({ name: 'multi-client-check', version: '1' }); t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/float-mcp.mjs', import.meta.url))], env }));
  const claude = await client.callTool({ name: 'pulse_snapshot', arguments: { client: 'claude-code', threadId: a } });
  assert.ok(!claude.isError); assert.equal(claude.structuredContent.client, 'claude-code'); assert.equal(claude.structuredContent.usage.total_tokens, 110);
  assert.equal(claude.structuredContent.capabilities.visibleCharacters, false);
  const antigravity = await client.callTool({ name: 'pulse_snapshot', arguments: { client: 'antigravity' } });
  assert.ok(!antigravity.isError); assert.equal(antigravity.structuredContent.client, 'antigravity'); assert.equal(antigravity.structuredContent.usage, null);
  const codex = await client.callTool({ name: 'pulse_snapshot', arguments: {} });
  assert.equal(codex.structuredContent.client, 'codex'); assert.equal(codex.structuredContent.usage, null);
  assert.ok(!JSON.stringify(claude).includes('PRIVATE'));
});

test('native feed routes to Claude, switches sessions, updates new reports, and exits on parent EOF', async t => {
  const { root, projects, env } = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/float-feed.mjs', import.meta.url)), '--thread', a], {
    env: { ...env, CODEX_PULSE_CLIENT: 'claude-code' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let pending = '', latest; child.stdout.on('data', data => { pending += data; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) if (line) latest = JSON.parse(line); });
  child.stderr.resume();
  const wait = async fn => { const end = Date.now() + 6000; while (!fn()) { assert.equal(child.exitCode, null, 'feed must stay alive'); assert.ok(Date.now() < end, 'feed update timed out'); await delay(20); } };
  await wait(() => latest?.client === 'claude-code'); assert.equal(latest.usage.total_tokens, 110);
  child.stdin.write(JSON.stringify({ type: 'scope', mode: 'thread', threadId: b }) + '\n');
  await wait(() => latest?.selectedId === b); assert.equal(latest.usage.total_tokens, 130);
  await appendFile(path.join(projects, b + '.jsonl'), event(b, 'three', 5)); await wait(() => latest.usage.total_tokens === 235);
  assert.ok(!JSON.stringify(latest).includes('PRIVATE'));
  const exited = new Promise(resolve => child.once('exit', code => resolve(code))); child.stdin.end();
  assert.equal(await Promise.race([exited, delay(3000).then(() => 'timeout')]), 0);
});
