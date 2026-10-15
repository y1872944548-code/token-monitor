const tokenKeys = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function normalizeUsage(raw) {
  return Object.fromEntries(tokenKeys.map(key => [key, number(raw?.[key])]));
}
export function normalizeLimits(raw) {
  const window = value => value ? {
    usedPercent: number(value.used_percent ?? value.usedPercent),
    windowMinutes: number(value.window_minutes ?? value.windowDurationMins),
    resetsAt: number(value.resets_at ?? value.resetsAt)
  } : null;
  return raw ? { limitId: raw.limit_id ?? raw.limitId ?? 'codex', primary: window(raw.primary), secondary: window(raw.secondary) } : null;
}
export class Metrics {
  constructor() { this.points = []; this.limits = null; this.model = null; this.status = 'unknown'; this.lastActivity = null; this.usage = null; this.ledgerSeen = false; }
  accept(record) {
    const time = Date.parse(record.timestamp);
    if (!Number.isFinite(time)) return;
    if (record.type === 'turn_context') this.model = typeof record.payload?.model === 'string' ? record.payload.model.slice(0, 100) : this.model;
    const ledger = record.type === 'token_usage_record';
    if (record.type !== 'event_msg' && !ledger) return;
    const event = ledger ? { type: 'token_count', info: { total_token_usage: record.payload?.thread_token_usage } } : record.payload;
    if (!event) return;
    if (event.type === 'task_started') { this.status = 'running'; this.lastActivity = time; }
    if (['task_complete', 'task_completed', 'turn_aborted'].includes(event.type)) { this.status = event.type === 'turn_aborted' ? 'interrupted' : 'completed'; this.lastActivity = time; }
    if (event.type === 'item_completed') this.lastActivity = time;
    if (event.type !== 'token_count') return;
    if (event.rate_limits) this.limits = { ...normalizeLimits(event.rate_limits), observedAt: time };
    if (!event.info?.total_token_usage) return;
    const usage = normalizeUsage(event.info.total_token_usage);
    if (usage.total_tokens === null) return;
    const prev = this.points.at(-1);
    if (prev && time <= prev.time) return;
    // Legacy token_count can arrive after a newer ledger with an older cumulative value.
    if (!ledger && this.ledgerSeen && prev && usage.total_tokens < prev.usage.total_tokens) return;
    if (ledger) this.ledgerSeen = true;
    if (prev && tokenKeys.every(key => usage[key] === prev.usage[key])) return;
    const delta = prev && usage.output_tokens !== null && prev.usage.output_tokens !== null ? usage.output_tokens - prev.usage.output_tokens : null;
    const elapsed = prev ? (time - prev.time) / 1000 : null;
    const rate = delta !== null && delta >= 0 && elapsed > 0 ? delta / elapsed : null;
    this.points.push({ time, usage, rate, intervalSeconds: elapsed });
    if (this.points.length > 1500) this.points.shift();
    this.usage = usage; this.lastActivity = time;
  }
  snapshot(now = Date.now()) {
    const latest = this.points.at(-1);
    return { usage: this.usage, points: this.points, limits: this.limits, model: this.model, status: this.status,
      lastActivity: this.lastActivity, latestRate: latest?.rate ?? null, rateIntervalSeconds: latest?.intervalSeconds ?? null,
      observedAt: latest?.time ?? null, ageSeconds: latest ? Math.max(0, (now - latest.time) / 1000) : null };
  }
}
