import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Metrics } from '../src/metrics.mjs';
import { Monitor } from '../src/monitor.mjs';
import { startServer } from '../src/server.mjs';
const id = '01a13949-b780-71a2-8863-a7f53db88ead';
const usage = (seconds, total, output, extra = {}) => ({ timestamp: new Date(Date.UTC(2026, 9, 14, 0, 0, seconds)).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total - output, cached_input_tokens: 20, output_tokens: output, reasoning_output_tokens: 3, total_tokens: total } }, ...extra } });
test('aggregate totals and output pace do not double count cached or reasoning tokens', () => {
  const metrics = new Metrics(); metrics.accept(usage(0, 100, 10)); metrics.accept(usage(10, 200, 40));
  const current = metrics.snapshot(); assert.equal(current.usage.total_tokens, 200); assert.equal(current.latestRate, 3);
  assert.equal(current.rateIntervalSeconds, 10);
  metrics.accept(usage(11, 200, 40)); assert.equal(metrics.points.length, 2);
});
test('missing counts and reset counters remain unknown rather than fake zero rates', () => {
  const metrics = new Metrics(); assert.equal(metrics.snapshot().latestRate, null);
  metrics.accept(usage(0, 100, 10)); assert.equal(metrics.snapshot().latestRate, null);
  metrics.accept(usage(10, 80, 5)); assert.equal(metrics.snapshot().latestRate, null);
  metrics.accept({ ...usage(20, 200, 50), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 200 } } } });
  assert.equal(metrics.snapshot().latestRate, null); assert.equal(metrics.snapshot().usage.input_tokens, null);
});
test('account windows stay separate and sensitive fields do not enter output', () => {
  const metrics = new Metrics(); metrics.accept(usage(0, 100, 10, { rate_limits: { primary: { used_percent: 37, window_minutes: 300, resets_at: 1791963984 }, credits: { balance: 'secret' }, accountId: 'secret' } }));
  assert.equal(metrics.snapshot().limits.primary.usedPercent, 37); assert.equal(metrics.snapshot().limits.secondary, null);
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('secret'));
  metrics.accept({ timestamp: new Date().toISOString(), type: 'response_item', payload: { text: 'private conversation' } });
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('private conversation'));
});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-pulse-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ...new Date().toISOString().slice(0, 10).split('-')); await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-${id}.jsonl`); await writeFile(file, JSON.stringify(usage(0, 100, 10)) + '\n');
  return { root, file };
}
test('incremental reader waits for full JSON lines and survives malformed lines and truncation', async t => {
  const { root, file } = await fixture(t); const monitor = new Monitor({ root, threadId: id }); await monitor.tick();
  const next = JSON.stringify(usage(10, 200, 40)); await appendFile(file, next.slice(0, 50)); await monitor.tick();
  assert.equal(monitor.snapshot().usage.total_tokens, 100);
  await appendFile(file, next.slice(50) + '\nmalformed\n'); await monitor.tick();
  assert.equal(monitor.snapshot().latestRate, 3);
  await writeFile(file, JSON.stringify(usage(20, 80, 5)) + '\n'); await monitor.tick();
  assert.equal(monitor.snapshot().usage.total_tokens, 80); assert.equal(monitor.snapshot().latestRate, null);
  await assert.rejects(monitor.select('../../auth.json')); assert.equal(monitor.snapshot().selectedId, id);
});
test('incremental reader consumes ledger-only append before any legacy token count', async t => {
  const { root, file } = await fixture(t); const monitor = new Monitor({ root, threadId: id }); await monitor.tick();
  const source = usage(10,200,40);
  await appendFile(file,JSON.stringify({ timestamp: source.timestamp, type:'token_usage_record', payload:{ thread_token_usage:source.payload.info.total_token_usage } })+'\n');
  await monitor.tick(); assert.equal(monitor.snapshot().usage.total_tokens,200); assert.equal(monitor.snapshot().latestRate,3);
  await appendFile(file,JSON.stringify(usage(11,200,40))+'\n'); await monitor.tick(); assert.equal(monitor.snapshot().points.length,2);
});
test('loopback API blocks cross-origin, rebinding host, arbitrary paths and returns real metrics', async t => {
  const { root } = await fixture(t); const monitor = new Monitor({ root });
  const service = await startServer({ port: 0, monitor }); t.after(() => service.close());
  const response = await fetch(`${service.url}/api/snapshot`); const data = await response.json();
  assert.equal(data.usage.total_tokens, 100); assert.equal(data.kind, 'codex-pulse');
  assert.equal((await fetch(`${service.url}/api/snapshot`, { headers: { Origin: 'https://malicious.example' } })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${service.url}/api/snapshot`, { headers: { Host: 'malicious.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await fetch(`${service.url}/auth.json`)).status, 404);
  assert.equal((await fetch(`${service.url}/api/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: '../../auth.json' }) })).status, 400);
  const stream = await fetch(`${service.url}/api/events`); const reader = stream.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value); assert.ok(chunk.startsWith('data: ')); assert.ok(chunk.includes('"total_tokens":100')); await reader.cancel();
});
test('SSE delivers a second real update without another model or HTTP request', async t => {
  const { root, file } = await fixture(t);
  const service = await startServer({ port: 0, monitor: new Monitor({ root }) }); t.after(() => service.close());
  const response = await fetch(`${service.url}/api/events`, { signal: AbortSignal.timeout(5000) });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value); assert.ok(first.includes('"total_tokens":100'));
  await appendFile(file, JSON.stringify(usage(10, 250, 70)) + '\n');
  const second = new TextDecoder().decode((await reader.read()).value); assert.ok(second.includes('"total_tokens":250'));
  assert.ok(second.includes('"latestRate":6')); await reader.cancel();
});
