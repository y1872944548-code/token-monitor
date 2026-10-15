import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/server.mjs';
const url = 'http://127.0.0.1:5397';
const snapshot = await (await fetch(`${url}/api/snapshot`)).json();
assert.equal(snapshot.kind, 'codex-pulse');
const response = await fetch(`${url}/api/events`, { signal: AbortSignal.timeout(6000) });
const reader = response.body.getReader();
let buffer = '', observations = [];
while (observations.length < 2) {
  const chunk = await reader.read(); if (chunk.done) throw new Error('推送提前终止');
  buffer += new TextDecoder().decode(chunk.value);
  while (buffer.includes('\n\n')) {
    const end = buffer.indexOf('\n\n'); const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    if (event.startsWith('data: ')) observations.push(JSON.parse(event.slice(6)));
  }
}
await reader.cancel();
assert.ok(observations[1].now > observations[0].now);
assert.equal(observations[0].selectedId, observations[1].selectedId);
const report = { checkedAt: new Date().toISOString(), result: 'PASS', selectedId: snapshot.selectedId,
  totalTokens: snapshot.usage?.total_tokens, outputTokens: snapshot.usage?.output_tokens,
  observations: observations.slice(0, 2).map(value => ({ now: value.now, count: value.points.length, observedAt: value.observedAt })),
  note: '最终服务真实快照与连续SSE心跳通过；未请求推理或输出聊天正文。' };
await mkdir(path.join(projectRoot, 'QA'), { recursive: true });
await writeFile(path.join(projectRoot, 'QA/live-check.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
