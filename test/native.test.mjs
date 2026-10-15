import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/native-mcp.mjs';
import { widgetHtml, WIDGET_URI } from '../src/widget.mjs';

const idA = '01a13949-b780-71a2-8863-a7f53db88ead', idB = '01a13954-ca4d-7fc2-b273-8e167fdd5c4a';
const event = total => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } } } }) + '\n';
test('native plugin registers thread entrypoint and app-only data; reads real increments without HTTP', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-native-'));
  const dir = path.join(root, ...new Date().toISOString().slice(0, 10).split('-')); await mkdir(dir, { recursive: true });
  const fileA = path.join(dir, `rollout-${idA}.jsonl`), fileB = path.join(dir, `rollout-${idB}.jsonl`);
  await writeFile(fileA, event(100)); await writeFile(fileB, event(800));
  const server = createMcpServer({ root }); const client = new Client({ name: 'native-check', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const tools = (await client.listTools()).tools;
  for (const tool of tools) assert.ok(tool.outputSchema, 'structured outputs need a declared contract');
  const opener = tools.find(tool => tool.name === 'pulse_open'); assert.equal(opener._meta.ui.resourceUri, WIDGET_URI);
  assert.deepEqual(opener._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  assert.deepEqual(tools.find(tool => tool.name === 'pulse_data')._meta.ui.visibility, ['app']);
  const opened = await client.callTool({ name: 'pulse_open', arguments: { threadId: idA } });
  assert.equal(opened.structuredContent.usage.total_tokens, 100); assert.equal(opened.structuredContent.url, undefined);
  assert.equal(opened.structuredContent.points, undefined); assert.equal(opened._meta.pulseData.points.length, 1);
  const other = await client.callTool({ name: 'pulse_data', arguments: { threadId: idB } }); assert.equal(other._meta.pulseData.usage.total_tokens, 800);
  await appendFile(fileA, event(250));
  const next = await client.callTool({ name: 'pulse_data', arguments: { threadId: idA } }); assert.equal(next._meta.pulseData.usage.total_tokens, 250);
  assert.equal(next._meta.pulseData.selectedId, idA);
  const invalid = await client.callTool({ name: 'pulse_data', arguments: { threadId: '11111111-1111-4111-8111-111111111111' } }); assert.equal(invalid.isError, true);
  const resource = (await client.readResource({ uri: WIDGET_URI })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app'); assert.deepEqual(resource._meta.ui.csp.connectDomains, []);
});
test('native component bundles parseable scripts and assets without a page URL or external resources', async () => {
  const html = await widgetHtml();
  assert.ok(html.includes('<body class="compact">')); assert.ok(html.includes('window.PULSE_HOST'));
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/i.test(html));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 3); for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
});
test('UI host bridge initializes once, polls directly, rejects foreign messages and releases polling', async () => {
  const bridge = await readFile(new URL('../public/host-bridge.js', import.meta.url), 'utf8');
  const listeners = new Map(); const calls = [], callbacks = new Map(); let seq = 0, listener;
  const timers = new Map(); let timerId = 0;
  let holdNext = false, heldReply = null;
  const parent = { postMessage(message) {
    calls.push(message);
    if (!message.id) return;
    const result = message.method === 'ui/initialize' ? { protocolVersion: '2026-01-26' } : {
      _meta: { pulseData: { kind: 'codex-pulse', selectedId: message.params.arguments.threadId || idA, now: ++seq } }
    };
    const reply = () => listener?.({ source: parent, data: { jsonrpc: '2.0', id: message.id, result } });
    if (holdNext && message.method === 'tools/call') { holdNext = false; heldReply = reply; }
    else queueMicrotask(reply);
  } };
  const window = { parent, addEventListener(name, handler) { listeners.set(name, handler); listener = handler; }, removeEventListener(name) { listeners.delete(name); } };
  const context = { window, queueMicrotask, JSON, Map, Promise, Error, setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); }, fetch() { throw new Error('native UI must not fetch'); } };
  vm.runInNewContext(bridge, context);
  const stream = window.PULSE_HOST.connect(); const values = []; stream.onmessage = message => values.push(JSON.parse(message.data));
  for (let n = 0; n < 12; n++) await Promise.resolve();
  assert.equal(values.length, 1); assert.equal(calls.filter(call => call.method === 'ui/initialize').length, 1);
  listener({ source: {}, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { _meta: { pulseData: { kind: 'codex-pulse', selectedId: 'intruder' } } } } });
  assert.equal(values.length, 1);
  const timer = [...timers.entries()].find(([, item]) => item.ms === 1000); assert.ok(timer); timers.delete(timer[0]); await timer[1].fn();
  assert.equal(values.length, 2); assert.equal(values[1].selectedId, idA);
  await window.PULSE_HOST.select(idB); assert.equal(values.at(-1).selectedId, idB);
  holdNext = true;
  const slowA = window.PULSE_HOST.select(idA);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  assert.ok(heldReply);
  await window.PULSE_HOST.select(idB); heldReply(); await slowA;
  assert.equal(values.at(-1).selectedId, idB, 'a late earlier selection cannot overwrite the newer selection');
  stream.close(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
});
