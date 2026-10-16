// Counts come exclusively from the provider's cumulative usage fields.
// Text deltas and event counts are never used to infer tokens.
const count = value => Number.isSafeInteger(value) && value >= 0;
export class OfficialTokenStream {
  constructor(now = Date.now) { this.now = now; this.ids = new Set(); this.reset(); this.errors = 0; }
  reset() {
    this.startedAt = null; this.observedAt = null; this.outputTokens = null;
    this.interval = null; this.completed = false; this.finalTokens = null; this.finalAt = null; this.updates = 0; this.invalid = false;
  }
  accept(event) {
    const now = this.now();
    if (event.type === 'message_start') {
      const id = event.message?.id;
      if (typeof id !== 'string' || !id || id.length > 256 || this.ids.has(id)) return;
      this.ids.add(id); if (this.ids.size > 10000) this.ids.delete(this.ids.values().next().value);
      this.reset(); this.startedAt = now;
      const tokens = event.message?.usage?.output_tokens;
      if (count(tokens)) { this.outputTokens = tokens; this.observedAt = now; }
      else if (tokens !== undefined && tokens !== null) { this.errors++; this.invalid = true; }
      return;
    }
    if (this.startedAt === null || this.invalid) return;
    if (event.type === 'message_stop') { this.completed = true; return; }
    if (event.type !== 'message_delta' || this.completed) return;
    if (event.delta?.stop_reason !== null && typeof event.delta?.stop_reason !== 'string') return;
    const tokens = event.usage?.output_tokens;
    if (tokens === undefined || tokens === null) return;
    if (!count(tokens) || this.outputTokens !== null && tokens < this.outputTokens || now < this.observedAt) {
      this.errors++; this.invalid = true; this.interval = null; return;
    }
    const final = typeof event.delta?.stop_reason === 'string';
    if (this.outputTokens !== null && tokens > this.outputTokens && now > this.observedAt) {
      this.interval = { from: this.observedAt, to: now, tokens: tokens - this.outputTokens, final };
      if (!final && event.delta?.stop_reason === null) this.updates++;
    }
    // A repeated count is not a new observation of generated tokens. Advancing
    // its timestamp would understate the next delta's interval.
    if (this.outputTokens === null || tokens > this.outputTokens) { this.outputTokens = tokens; this.observedAt = now; }
    if (final) { this.completed = true; this.finalTokens = tokens; this.finalAt = now; }
  }
  snapshot() {
    return { source: 'anthropic-stream-usage', startedAt: this.startedAt, observedAt: this.observedAt,
      outputTokens: this.outputTokens, interval: this.interval, completed: this.completed,
      finalTokens: this.finalTokens, finalAt: this.finalAt, midstreamUpdates: this.updates, counterErrors: this.errors, invalid: this.invalid };
  }
}

export function validTokenState(value, updatedAt) {
  const stamp = x => x === null || count(x) && x <= updatedAt;
  const nullableCount = x => x === null || count(x);
  if (!value || value.source !== 'anthropic-stream-usage' || !stamp(value.startedAt) || !stamp(value.observedAt) || !stamp(value.finalAt)
    || !nullableCount(value.outputTokens) || !nullableCount(value.finalTokens) || !count(value.midstreamUpdates) || !count(value.counterErrors)
    || typeof value.completed !== 'boolean' || typeof value.invalid !== 'boolean') return false;
  if (value.startedAt === null && (value.observedAt !== null || value.outputTokens !== null || value.interval !== null || value.finalAt !== null)) return false;
  if ((value.observedAt === null) !== (value.outputTokens === null) || (value.finalAt === null) !== (value.finalTokens === null)) return false;
  if (value.observedAt !== null && value.observedAt < value.startedAt || value.finalAt !== null && (value.finalAt < value.startedAt || !value.completed || value.finalTokens === null)) return false;
  const interval = value.interval;
  return interval === null || !value.invalid && count(interval.from) && count(interval.to) && interval.from >= value.startedAt && interval.to <= value.observedAt
    && interval.to > interval.from && count(interval.tokens) && interval.tokens > 0 && interval.tokens <= value.outputTokens && typeof interval.final === 'boolean';
}

export function tokenDisplay(rows, config, now) {
  const selected = rows.filter(row => config.mode === 'all' || row.sessionId === config.threadId);
  const eligible = selected.filter(row => row.officialTokens && (config.mode !== 'all' || row.officialTokens.startedAt >= config.globalStartedAt));
  const active = eligible.filter(row => !row.ended && now - row.updatedAt < 3000);
  const candidate = (active.length ? active : eligible).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const value = candidate?.officialTokens;
  const base = { source: 'anthropic-stream-usage', exactCounts: !!value && value.outputTokens !== null && !value.invalid,
    rate: null, responseRate: null, status: 'waiting', outputTokens: value?.outputTokens ?? null,
    observedAt: value?.observedAt ?? null, midstreamUpdates: value?.midstreamUpdates ?? 0, counterErrors: value?.counterErrors ?? 0,
    unit: 'tokens/s', basis: 'official-counts-and-local-receive-time', intervalSeconds: null };
  if (!value) return base;
  if (config.mode === 'all') return { ...base, status: 'select-session', exactCounts: false, outputTokens: null, observedAt: null };
  if (value.invalid) return { ...base, exactCounts: false, status: 'counter-error' };
  const interval = value.interval;
  if (!value.completed && interval && !interval.final && value.midstreamUpdates > 0 && interval.to <= now && now - interval.to < 3000 && active.length) {
    const seconds = (interval.to - interval.from) / 1000;
    return { ...base, rate: interval.tokens / seconds, intervalSeconds: seconds, status: 'live' };
  }
  if (value.finalAt !== null && value.finalAt <= now && now - value.finalAt < 30000 && value.finalAt > value.startedAt) {
    const seconds = (value.finalAt - value.startedAt) / 1000;
    return { ...base, responseRate: value.finalTokens / seconds, observedAt: value.finalAt, intervalSeconds: seconds,
      status: value.midstreamUpdates > 0 ? 'completed' : 'completion-only' };
  }
  return { ...base, status: !candidate.ended && now - candidate.updatedAt < 3000 ? 'waiting' : 'disconnected' };
}
