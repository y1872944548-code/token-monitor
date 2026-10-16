import { readdir, open, realpath, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { isId, insideRoots } from './thread-catalog.mjs';

const MAX_FILES = 128, MAX_BYTES = 8192;
export async function writeStreamState(directory, state) {
  if (!isId(state.sessionId)) throw new Error('Invalid stream session');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, state.sessionId + '.json');
  await writeFile(file + '.tmp', JSON.stringify(state) + '\n', { mode: 0o600 });
  await rename(file + '.tmp', file);
}

export class ClaudeLiveReader {
  constructor(directory, now = Date.now) { this.directory = directory; this.now = now; this.rows = []; this.errors = 0; this.partial = false; }
  async tick() {
    this.rows = []; this.errors = 0; this.partial = false;
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') this.errors++; return; }
    const names = entries.filter(x => x.isFile() && x.name.endsWith('.json') && isId(x.name.slice(0, -5)));
    // Scan the most recently changed candidates, including after many old runs.
    // Only a bounded number of small state files are read per sample.
    const candidates = [];
    for (const entry of names.slice(0, 4096)) try {
      const modified = (await stat(path.join(this.directory, entry.name))).mtimeMs;
      if (modified > Date.now() - 10000) candidates.push({ name: entry.name, modified });
    } catch { this.errors++; }
    this.partial = names.length > 4096 || candidates.length > MAX_FILES;
    for (const { name } of candidates.sort((a, b) => b.modified - a.modified).slice(0, MAX_FILES)) {
      let handle;
      try {
        const file = await insideRoots(path.join(this.directory, name), [await realpath(this.directory)]);
        handle = await open(file, 'r'); const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid stream state size');
        const buffer = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) throw new Error('Invalid stream state size');
        const row = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        if (!validState(row, name.slice(0, -5), this.now())) throw new Error('Invalid stream state');
        this.rows.push(row);
      } catch { this.errors++; } finally { await handle?.close(); }
    }
  }
  sessions() { return this.rows.filter(row => this.now() - row.updatedAt < 5000).map(row => ({ id: row.sessionId, modifiedAt: row.updatedAt, streamOnly: true })); }
  snapshot(config) {
    const now = this.now(), rows = this.rows.filter(row => now - row.updatedAt < 3000 && (config.mode === 'all' || row.sessionId === config.threadId));
    const ready = rows.filter(row => !row.ended || row.lastTextAt !== null && now - row.lastTextAt < 2000);
    const buckets = ready.flatMap(row => row.buckets).filter(row => row.time > now - 2000 && (config.mode !== 'all' || row.time >= config.globalStartedAt));
    return { connected: ready.length > 0, synchronized: ready.length > 0, connectedStreams: ready.length,
      rate: buckets.reduce((sum, row) => sum + row.count, 0) / 2, unit: 'characters/s', windowSeconds: 2,
      lastTextAt: buckets.length ? Math.max(...buckets.map(row => row.time)) : null,
      source: 'claude-stream-json', readErrors: this.errors, partial: this.partial };
  }
}
function validState(row, id, now) {
  const integer = x => Number.isSafeInteger(x) && x >= 0;
  return row?.format === 1 && row.client === 'claude-code' && row.sessionId === id && integer(row.updatedAt) && row.updatedAt <= now + 1000
    && typeof row.ended === 'boolean' && integer(row.characters) && (row.lastTextAt === null || integer(row.lastTextAt) && row.lastTextAt <= row.updatedAt)
    && Array.isArray(row.buckets) && row.buckets.length <= 21 && row.buckets.every((x, index) => integer(x.time) && x.time <= row.updatedAt && integer(x.count)
      && x.count <= 1024 * 1024 && (index === 0 || x.time > row.buckets[index - 1].time));
}
