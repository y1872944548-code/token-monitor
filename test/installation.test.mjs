import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureMcp } from '../scripts/configure-mcp.mjs';
const exec = promisify(execFile);

test('MCP setup resolves paths with spaces and Unicode, preserves other servers and repeats safely', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulse 中文 project '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: { other: { command: 'other-server' }, 'codex-pulse': { command: 'old-machine-path' } } }));
  const generated = await configureMcp(root);
  assert.equal(generated.command, process.execPath);
  assert.deepEqual(generated.args, [path.join(root, 'src', 'float-mcp.mjs')]);
  assert.equal(generated.cwd, root);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcpServers.other.command, 'other-server');
  const first = await readFile(file, 'utf8');
  await configureMcp(root);
  assert.equal(await readFile(file, 'utf8'), first);
  await writeFile(file, '{invalid existing config');
  await assert.rejects(configureMcp(root));
  assert.equal(await readFile(file, 'utf8'), '{invalid existing config');
});

test('first-run bootstrap needs no conversation ID, preserves the epoch and never overwrites corrupt settings', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pulse-bootstrap-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const data = path.join(home, 'data');
  const env = { ...process.env, CODEX_HOME: home, CODEX_PULSE_DATA_DIR: data };
  delete env.CODEX_PULSE_SETTINGS_FILE;
  const bootstrap = () => exec(process.execPath, [fileURLToPath(new URL('../src/portable-bootstrap.mjs', import.meta.url))], { env });
  const first = JSON.parse((await bootstrap()).stdout);
  assert.match(first.threadId, /^[0-9a-f-]{36}$/);
  assert.equal(first.mode, 'all');
  assert.equal(first.localThreads, 0);
  assert.equal(first.indexAvailable, false);
  const file = path.join(data, 'monitor-settings.json');
  const initial = await readFile(file, 'utf8');
  assert.equal(JSON.parse((await bootstrap()).stdout).threadId, first.threadId);
  assert.equal(await readFile(file, 'utf8'), initial);
  await writeFile(file, '{broken');
  await assert.rejects(bootstrap());
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
