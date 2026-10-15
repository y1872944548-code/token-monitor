import { readdir, stat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Metrics } from './metrics.mjs';

const MAX_READ = 8 * 1024 * 1024;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.jsonl$)/i;
export class Monitor {
  constructor({ root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), threadId = null, catalog = null, extraRoots = [] } = {}) {
    this.root = path.resolve(root); this.selectedId = threadId; this.sessions = []; this.metrics = new Metrics();
    this.position = 0; this.pending = Buffer.alloc(0); this.file = null; this.error = null; this.lastDiscover = 0; this.skippedBytes = 0;
    this.catalog=catalog;this.extraRoots=extraRoots;
  }
  async discover() {
    if(this.catalog){this.sessions=await this.catalog();this.lastDiscover=Date.now();if(!this.selectedId&&this.sessions[0])this.selectedId=this.sessions[0].id;return;}
    const candidates = [];
    // Inspect only recent date folders, never conversation contents for discovery.
    for (let day = -1; day < 8; day++) {
      const date = new Date(Date.now() - day * 86400000).toISOString().slice(0, 10).split('-');
      const dir = path.join(this.root, ...date);
      let names;
      try { names = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of names) {
        const id = entry.name.match(uuid)?.[0];
        if (!entry.isFile() || !id) continue;
        const file = path.join(dir, entry.name);
        const info = await stat(file);
        candidates.push({ id, file, modifiedAt: info.mtimeMs, size: info.size });
      }
    }
    this.sessions = candidates.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 40);
    this.lastDiscover = Date.now();
    if (!this.selectedId && this.sessions[0]) this.selectedId = this.sessions[0].id;
  }
  async select(id) {
    await this.discover();
    if (!this.sessions.some(session => session.id === id)) throw new Error('聊天不在最近本机日志列表中');
    if (id !== this.selectedId) { this.selectedId = id; this.file = null; }
    await this.tick();
  }
  async tick() {
    try {
      if (Date.now() - this.lastDiscover > 10000) await this.discover();
      const session = this.sessions.find(item => item.id === this.selectedId);
      if (!session) { this.error = '尚未找到选中聊天的本机日志'; return; }
      const resolvedFile = await realpath(session.file);
      let allowed=false;for(const root of [this.root,...this.extraRoots]){try{const relative=path.relative(await realpath(root),resolvedFile);if(!relative.startsWith('..')&&!path.isAbsolute(relative))allowed=true;}catch{}}
      if(!allowed)throw new Error('日志路径超出本机会话目录');
      const info = await stat(resolvedFile);
      if (this.file !== resolvedFile || info.size < this.position) {
        this.file = resolvedFile; this.metrics = new Metrics(); this.pending = Buffer.alloc(0);
        this.position = Math.max(0, info.size - MAX_READ); this.skippedBytes = this.position; this.dropFirstLine = this.position > 0;
      }
      let remaining = info.size - this.position;
      if (remaining > MAX_READ) {
        this.position = info.size - MAX_READ; this.pending = Buffer.alloc(0); this.dropFirstLine = true;
        this.skippedBytes += remaining - MAX_READ; remaining = MAX_READ;
      }
      if (remaining > 0) {
        const handle = await open(resolvedFile, 'r');
        try {
          const buffer = Buffer.alloc(remaining);
          const { bytesRead } = await handle.read(buffer, 0, remaining, this.position);
          this.position += bytesRead;
          const joined = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
          const end = joined.lastIndexOf(10);
          if (end >= 0) {
            let lines = joined.subarray(0, end).toString('utf8').split('\n');
            if (this.dropFirstLine) { lines.shift(); this.dropFirstLine = false; }
            for (const line of lines) {
              // Ignore response bodies before parsing: only aggregate metadata enters the monitor.
              if (!line.includes('"event_msg"') && !line.includes('"turn_context"') && !line.includes('"token_usage_record"')) continue;
              try { this.metrics.accept(JSON.parse(line)); } catch { /* Partial / malformed lines do not corrupt metrics. */ }
            }
            this.pending = joined.subarray(end + 1);
          } else this.pending = joined.length <= MAX_READ ? joined : Buffer.alloc(0);
        } finally { await handle.close(); }
      }
      this.error = null;
    } catch { this.error = '日志读取失败；保留最后观测值，请检查目录访问或日志格式'; }
  }
  snapshot() {
    return { kind: 'codex-pulse', version: '0.1.0', now: Date.now(), selectedId: this.selectedId,
      sessions: this.sessions.map(({ id, modifiedAt }) => ({ id, modifiedAt })),
      error: this.error, skippedBytes: this.skippedBytes, ...this.metrics.snapshot() };
  }
}
