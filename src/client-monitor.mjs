import { readdir, stat, open, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CLIENTS, clientId, clientHome, clientDataDir } from './clients.mjs';
import { isId, insideRoots } from './thread-catalog.mjs';
import { parseAntigravityRecord } from './antigravity-record.mjs';
import { ClaudeLiveReader } from './claude-live.mjs';

const READ = 8 * 1024 * 1024, MAX_FILES = 500, MAX_MESSAGES = 20000;
const keys = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function parseClaudeRecord(record, sessionId) {
  if (record.type !== 'assistant' || (record.sessionId && record.sessionId !== sessionId)) return null;
  const message = record.message, raw = message?.usage, time = Date.parse(record.timestamp);
  if (!raw || typeof message.id !== 'string' || message.id.length > 256 || !Number.isFinite(time)) return null;
  const fresh = count(raw.input_tokens), output = count(raw.output_tokens);
  const read = raw.cache_read_input_tokens === undefined ? 0 : count(raw.cache_read_input_tokens);
  const write = raw.cache_creation_input_tokens === undefined ? 0 : count(raw.cache_creation_input_tokens);
  if ([fresh, output, read, write].includes(null)) throw new Error('Unsupported Claude usage');
  const input = fresh + read + write, total = input + output;
  if (!Number.isSafeInteger(total)) throw new Error('Usage overflow');
  return { responseId: message.id, time, usage: { input_tokens: input, cached_input_tokens: read,
    output_tokens: output, reasoning_output_tokens: null, total_tokens: total } };
}

export class ClientMonitor {
  constructor({ client, home = clientHome(client), threadId = null, settingsFile, dataDir = settingsFile ? path.dirname(settingsFile) : clientDataDir(client), now = Date.now } = {}) {
    this.client = clientId(client); if (this.client === 'codex') throw new Error('Use the Codex ScopeEngine');
    this.home = path.resolve(home); this.settingsFile = settingsFile; this.now = now;
    this.config = { mode: 'thread', threadId, globalStartedAt: null };
    this.catalog = { entries: [], restricted: false, publicList: () => this.catalog.entries.map(({ id, modifiedAt }) => ({ id, title: CLIENTS[this.client] + ' · ' + id.slice(0, 8), modifiedAt })) };
    this.files = new Map(); this.lastDiscover = 0; this.readErrors = 0; this.discoveryErrors = 0; this.partial = false; this.enabled = true; this.controlError = null;
    this.points = []; this.messageCount = 0; this.pendingFiles = 0;
    this.livePoints = []; this.live = client === 'claude-code' ? new ClaudeLiveReader(path.join(dataDir, 'streams'), now) : null;
  }
  async initialize() {
    if (this.settingsFile) try {
      const saved = JSON.parse(await readFile(this.settingsFile, 'utf8'));
      if (['thread', 'all'].includes(saved.mode) && isId(saved.threadId)) this.config = { mode: saved.mode, threadId: saved.threadId, globalStartedAt: Number.isFinite(saved.globalStartedAt) ? saved.globalStartedAt : null };
    } catch (error) { if (error.code !== 'ENOENT') this.controlError = '监控设置不可读，尚未覆盖原文件'; }
    if (this.config.mode === 'all' && !this.config.globalStartedAt) this.config.globalStartedAt = this.now();
    await this.live?.tick(); await this.discover();
  }
  async discover() {
    this.lastDiscover = this.now(); this.discoveryErrors = 0; this.discoveryPartial = false; this.unsupportedFiles = 0;
    const entries = [], known = new Set();
    const list = async dir => { try { return await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') this.discoveryErrors++; return []; } };
    const roots = this.client === 'claude-code' ? [path.join(this.home, 'projects')] : [this.home, path.join(this.home, 'conversations')];
    const dirs = this.client === 'claude-code' ? (await list(roots[0])).filter(x => x.isDirectory()).slice(0, MAX_FILES).map(x => path.join(roots[0], x.name)) : roots;
    if (this.client === 'claude-code' && dirs.length === MAX_FILES) this.discoveryPartial = true;
    for (const dir of dirs) {
      for (const file of await list(dir)) {
        if (this.client === 'antigravity' && file.isFile() && file.name.endsWith('.pb')) this.unsupportedFiles++;
        const ext = this.client === 'claude-code' ? '.jsonl' : '.db';
        if (!file.isFile() || !file.name.endsWith(ext)) continue;
        const id = file.name.slice(0, -ext.length); if (!isId(id)) continue;
        if (entries.length >= MAX_FILES) { this.discoveryPartial = true; break; }
        try {
          const actual = await insideRoots(path.join(dir, file.name), roots); if (known.has(actual)) continue; known.add(actual);
          const info = await stat(actual); entries.push({ id, file: actual, modifiedAt: info.mtimeMs, size: info.size });
        } catch { this.discoveryErrors++; }
      }
    }
    this.catalog.entries = entries.sort((a, b) => b.modifiedAt - a.modifiedAt); this.roots = roots;
    const present = new Set(entries.map(x => x.file)); for (const file of this.files.keys()) if (!present.has(file)) this.files.delete(file);
    this.messageCount = [...this.files.values()].reduce((n, state) => n + state.messages.size, 0);
    if (!isId(this.config.threadId) && entries[0]) this.config.threadId = entries[0].id;
    this.mergeLiveCatalog();
  }
  mergeLiveCatalog() {
    if (!this.live) return;
    this.catalog.entries = this.catalog.entries.filter(row => !row.streamOnly);
    for (const row of this.live.sessions()) if (!this.catalog.entries.some(entry => entry.id === row.id)) this.catalog.entries.push(row);
    this.catalog.entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
    if (!isId(this.config.threadId) && this.catalog.entries[0]) this.config.threadId = this.catalog.entries[0].id;
  }
  async persist(next) {
    if (!this.settingsFile) return;
    await mkdir(path.dirname(this.settingsFile), { recursive: true });
    await writeFile(this.settingsFile + '.tmp', JSON.stringify(next, null, 2) + '\n'); await rename(this.settingsFile + '.tmp', this.settingsFile);
  }
  async select({ mode, threadId = this.config.threadId, resetGlobal = false }) {
    await this.discover();
    if (!['thread', 'all'].includes(mode) || !isId(threadId) || (mode === 'thread' && !this.catalog.entries.some(x => x.id === threadId))) throw new Error('未找到所选客户端的会话');
    const next = { mode, threadId, globalStartedAt: mode === 'all' && (resetGlobal || !this.config.globalStartedAt) ? this.now() : this.config.globalStartedAt };
    await this.persist(next); this.config = next; this.points = []; this.livePoints = []; this.controlError = null;
  }
  accept(state, record) {
    if (!record) return;
    const key = record.responseId;
    if (!state.messages.has(key) && this.messageCount >= MAX_MESSAGES) { state.partial = true; return; }
    const previous = state.messages.get(key);
    if (previous) {
      // Claude logs can repeat an assistant ID for content blocks or later usage updates.
      // Merge cumulative usage conservatively, never add replayed blocks twice.
      const increased = keys.some(k => (record.usage[k] ?? 0) > (previous.usage[k] ?? 0));
      record = { ...record, time: increased ? Math.max(previous.time, record.time) : previous.time, usage: Object.fromEntries(keys.map(k => [k,
        previous.usage[k] === null && record.usage[k] === null ? null : Math.max(previous.usage[k] ?? 0, record.usage[k] ?? 0)])) };
    }
    if (!previous) this.messageCount++;
    state.messages.set(key, record);
  }
  async readClaude(entry) {
    const actual = await insideRoots(entry.file, this.roots); const info = await stat(actual);
    let state = this.files.get(entry.file);
    if (!state || info.size < state.position || state.ino !== info.ino) {
      if (state) this.messageCount -= state.messages.size;
      const position = Math.max(0, info.size - READ);
      state = { id: entry.id, position, ino: info.ino, messages: new Map(), pending: Buffer.alloc(0), partial: position > 0, drop: position > 0 };
      this.files.set(entry.file, state);
    }
    const length = Math.min(READ, info.size - state.position);
    if (!length) return;
    const handle = await open(actual, 'r');
    try {
      const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, state.position); state.position += bytesRead;
      const joined = Buffer.concat([state.pending, buffer.subarray(0, bytesRead)]), end = joined.lastIndexOf(10);
      if (end < 0) { if (joined.length > 1024 * 1024) { state.pending = Buffer.alloc(0); state.drop = true; state.partial = true; } else state.pending = joined; return; }
      let lines = joined.subarray(0, end).toString('utf8').split('\n'); if (state.drop) { lines.shift(); state.drop = false; }
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.accept(state, parseClaudeRecord(JSON.parse(line), entry.id)); } catch { state.partial = true; }
      }
      state.pending = Buffer.from(joined.subarray(end + 1)); state.loading = state.position < info.size;
    } finally { await handle.close(); }
  }
  async readAntigravity(entry) {
    const actual = await insideRoots(entry.file, this.roots), info = await stat(actual);
    let wal; try { wal = await stat(actual + '-wal'); } catch {}
    const signature = [info.size, info.mtimeMs, wal?.size, wal?.mtimeMs].join(':');
    if (this.files.get(entry.file)?.signature === signature) return;
    const state = { id: entry.id, messages: new Map(), partial: false, signature };
    const db = new DatabaseSync(actual, { readOnly: true, allowExtension: false });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
      const tables = db.prepare("SELECT type, sql FROM sqlite_master WHERE name='gen_metadata' LIMIT 2").all();
      if (!tables.length) { const old = this.files.get(entry.file); if (old) this.messageCount -= old.messages.size; this.files.delete(entry.file); return; }
      if (tables.length !== 1 || tables[0].type !== 'table' || /VIRTUAL/i.test(tables[0].sql || '')) throw new Error('Unsupported history schema');
      const columns = db.prepare("PRAGMA table_xinfo('gen_metadata')").all();
      if (!columns.some(x => x.name === 'idx' && x.hidden === 0) || !columns.some(x => x.name === 'data' && x.hidden === 0)) throw new Error('Unsupported history columns');
      const old = this.files.get(entry.file); if (old) this.messageCount -= old.messages.size;
      let rows = 0, bytes = 0; const deadline = Date.now() + 500;
      for (const row of db.prepare("SELECT idx, CASE WHEN typeof(data)='blob' AND length(data)<=1048576 THEN data ELSE NULL END AS payload FROM gen_metadata LIMIT 10001").iterate()) {
        if (++rows > 10000 || Date.now() > deadline || (bytes += row.payload?.length || 0) > 32 * 1024 * 1024) { state.partial = true; break; }
        try {
          const record = parseAntigravityRecord(row.payload);
          if (record) { record.responseId ||= 'row:' + row.idx; this.accept(state, record); }
        } catch { state.partial = true; }
      }
      db.exec('COMMIT'); this.files.set(entry.file, state);
    } finally { db.close(); this.messageCount = [...this.files.values()].reduce((n, state) => n + state.messages.size, 0); }
  }
  async tick() {
    if (!this.enabled) return;
    await this.live?.tick(); this.mergeLiveCatalog();
    if (this.now() - this.lastDiscover > 3000) await this.discover();
    this.readErrors = 0;
    const selected = this.catalog.entries.filter(x => x.file && (this.config.mode !== 'thread' || x.id === this.config.threadId));
    const begin = (this.scanOffset || 0) % (selected.length || 1), work = [...selected.slice(begin), ...selected.slice(0, begin)];
    this.pendingFiles = 0;
    const deadline = Date.now() + 1500;
    for (const [index, entry] of work.entries()) {
      if (Date.now() > deadline) { this.pendingFiles = selected.length - index; this.scanOffset = (begin + index) % selected.length; break; }
      try { await (this.client === 'claude-code' ? this.readClaude(entry) : this.readAntigravity(entry)); } catch { this.readErrors++; }
    }
    let pendingBytes = 0;
    for (const state of this.files.values()) if (state.pending) {
      pendingBytes += state.pending.length;
      if (pendingBytes > 32 * 1024 * 1024) { pendingBytes -= state.pending.length; state.pending = Buffer.alloc(0); state.drop = true; state.partial = true; }
    }
  }
  snapshot() {
    const now = this.now(), records = new Map(); let partial = this.discoveryPartial || this.pendingFiles > 0 || this.readErrors > 0 || this.discoveryErrors > 0, sourceKnown = false;
    for (const state of this.files.values()) {
      if (this.config.mode === 'thread' && state.id !== this.config.threadId) continue;
      partial ||= state.partial || state.loading;
      sourceKnown ||= state.messages.size > 0;
      for (const row of state.messages.values()) {
        if (this.config.mode === 'all' && row.time < this.config.globalStartedAt) continue;
        if (row.time > now + 1000) { partial = true; continue; }
        const key = (this.client === 'claude-code' ? '' : state.id + ':') + row.responseId, prior = records.get(key);
        if (prior && JSON.stringify(prior.usage) !== JSON.stringify(row.usage)) { partial = true; continue; }
        records.set(key, row);
      }
    }
    const rows = [...records.values()], known = rows.length > 0 || this.config.mode === 'all' && sourceKnown && !partial;
    const usage = known ? Object.fromEntries(keys.map(k => [k, k === 'reasoning_output_tokens' ? null : rows.reduce((sum, x) => sum + (x.usage[k] ?? 0), 0)])) : null;
    if (usage && keys.some(k => usage[k] !== null && !Number.isSafeInteger(usage[k]))) { partial = true; for (const k of keys) usage[k] = null; }
    const observedAt = rows.length ? Math.max(...rows.map(x => x.time)) : null;
    const latestRate = known && usage?.total_tokens !== null ? rows.filter(x => x.time > now - 120000).reduce((sum, x) => sum + x.usage.output_tokens, 0) / 120 : null;
    if (latestRate !== null && (!this.points.length || now - this.points.at(-1).time >= 500)) { this.points.push({ time: now, rate: latestRate }); if (this.points.length > 250) this.points.shift(); }
    const liveOutput = this.live?.snapshot(this.config), liveReady = liveOutput?.connected && liveOutput.synchronized;
    if (liveReady || this.livePoints.length) {
      this.livePoints.push({ time: now, rate: liveReady ? liveOutput.rate : 0 });
      this.livePoints = this.livePoints.filter(row => row.time > now - 120000).slice(-250);
    }
    const error = liveReady && !known ? null : !this.catalog.entries.length ? this.unsupportedFiles ? '当前记录格式未支持' : '等待本机会话' : !known ? '尚无兼容用量' : partial ? '用量不完整' : null;
    return { kind: 'codex-pulse', version: '0.10.0', client: this.client, clientLabel: CLIENTS[this.client], now,
      selectedId: this.config.mode === 'all' ? null : this.config.threadId, usage, limits: null, observedAt,
      ageSeconds: observedAt === null ? null : Math.max(0, (now - observedAt) / 1000), latestRate, rateIntervalSeconds: 120,
      points: liveReady ? this.livePoints : this.points, reportedPoints: this.points, chartMetric: liveReady ? 'visible-characters-per-second' : 'reported-output-tokens-per-second',
      ...(liveOutput ? { liveOutput } : {}),
      sourceLabel: liveReady ? 'Claude stream-json · 实时字/s' : '本机记录 · 120s 上报均速', capabilities: { tokens: known, visibleCharacters: !!liveReady, accountLimits: false, experimental: this.client === 'antigravity', unsupportedFiles: this.unsupportedFiles },
      status: liveReady ? 'running' : 'unknown', lastActivity: Math.max(observedAt || 0, liveOutput?.lastTextAt || 0) || null, error, controlError: this.controlError,
      scope: { ...this.config, startedAt: this.config.globalStartedAt, client: this.client, indexAvailable: true,
        readErrors: this.readErrors + this.discoveryErrors, missingDetails: partial ? 1 : 0, loading: this.pendingFiles, catalogThreads: this.catalog.entries.length,
        coverage: partial ? 'partial' : known ? 'available' : 'unavailable', connectedStreams: liveOutput?.connectedStreams || 0,
        streamReadErrors: liveOutput?.readErrors || 0, streamCoverage: liveOutput?.partial ? 'partial' : liveReady ? 'available' : 'unavailable' } };
  }
  pause() { this.enabled = false; }
  resume() { this.enabled = true; this.lastDiscover = 0; }
  close() { this.pause(); }
}
