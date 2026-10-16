import { OfficialTokenStream } from './official-token-stream.mjs';
// Claude stream-json adapter. Only visible text deltas are counted; assistant
// snapshots, thinking, tools and subagent output never enter the speed metric.
export class ClaudeTextStream {
  constructor(sessionId, now = Date.now) {
    this.sessionId = sessionId; this.now = now; this.seen = new Set();
    this.blocks = new Set(); this.characters = 0; this.buckets = []; this.lastTextAt = null;
    this.tokens = new OfficialTokenStream(now);
  }
  accept(record) {
    if (record?.session_id !== this.sessionId || record.parent_tool_use_id != null) return '';
    if (record.type !== 'stream_event' || !record.event || typeof record.uuid !== 'string' || record.uuid.length > 256) return '';
    if (this.seen.has(record.uuid)) return '';
    this.seen.add(record.uuid);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
    const event = record.event;
    this.tokens.accept(event);
    if (event.type === 'message_start' || event.type === 'message_stop') this.blocks.clear();
    if (!Number.isSafeInteger(event.index) || event.index < 0 || event.index > 10000) return '';
    let text = '';
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      this.blocks.add(event.index); text = event.content_block.text;
    } else if (event.type === 'content_block_delta' && this.blocks.has(event.index) && event.delta?.type === 'text_delta') text = event.delta.text;
    else if (event.type === 'content_block_stop') this.blocks.delete(event.index);
    if (typeof text !== 'string' || !text) return '';
    const count = Array.from(text).length, now = this.now(), time = Math.floor(now / 100) * 100;
    this.characters += count; this.lastTextAt = now;
    this.buckets = this.buckets.filter(row => row.time > now - 2000);
    const previous = this.buckets.at(-1);
    if (previous?.time === time) previous.count += count; else this.buckets.push({ time, count });
    return text;
  }
  snapshot(ended = false) {
    const now = this.now(); this.buckets = this.buckets.filter(row => row.time > now - 2000);
    return { format: 2, client: 'claude-code', sessionId: this.sessionId, updatedAt: now, ended,
      characters: this.characters, lastTextAt: this.lastTextAt, buckets: this.buckets, officialTokens: this.tokens.snapshot() };
  }
}

// readline buffers an unlimited line. Cap bytes before parsing JSON, and accept
// a final line without a newline. No raw frame appears in errors or disk files.
export async function* jsonLines(readable, maxBytes = 1024 * 1024) {
  let pending = Buffer.alloc(0);
  for await (const chunk of readable) {
    const data = Buffer.concat([pending, Buffer.from(chunk)]); let start = 0;
    for (let end; (end = data.indexOf(10, start)) >= 0; start = end + 1) {
      if (end - start > maxBytes) throw new Error('Claude stream frame exceeds the size limit');
      const line = data.subarray(start, end).toString('utf8').trim();
      if (line) { try { yield JSON.parse(line); } catch { throw new Error('Claude stream contains invalid JSON'); } }
    }
    pending = Buffer.from(data.subarray(start));
    if (pending.length > maxBytes) throw new Error('Claude stream frame exceeds the size limit');
  }
  if (pending.toString('utf8').trim()) {
    try { yield JSON.parse(pending.toString('utf8')); } catch { throw new Error('Claude stream contains invalid JSON'); }
  }
}
