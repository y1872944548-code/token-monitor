import test from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/metrics.mjs';
const usage = (total, out) => ({ total_tokens: total, input_tokens: total-out, output_tokens: out });
const count = (seconds, total, out, limits) => ({ timestamp: new Date(seconds*1000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(total,out) }, rate_limits: limits } });
const ledger = (seconds, total, out) => ({ timestamp: new Date(seconds*1000).toISOString(), type: 'token_usage_record', payload: { thread_token_usage: usage(total,out) } });
test('early ledger updates immediately; delayed legacy duplicates neither double count nor regress', () => {
  const metrics = new Metrics();
  metrics.accept(count(0,100,10)); metrics.accept(ledger(10,200,40));
  assert.equal(metrics.snapshot().latestRate,3);
  metrics.accept(count(11,200,40)); assert.equal(metrics.points.length,2); assert.equal(metrics.snapshot().observedAt,10000);
  metrics.accept(count(12,100,10,{ primary: { used_percent:25 } }));
  assert.equal(metrics.snapshot().usage.total_tokens,200); assert.equal(metrics.snapshot().limits.primary.usedPercent,25);
  metrics.accept(ledger(20,300,80)); assert.equal(metrics.snapshot().latestRate,4);
});
