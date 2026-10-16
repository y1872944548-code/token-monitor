import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Monitor } from './monitor.mjs';
import { ThreadCatalog, isId } from './thread-catalog.mjs';
import { clientId, clientDataDir } from './clients.mjs';
import { ClientMonitor } from './client-monitor.mjs';

export async function sampleFloat({ threadId, codexHome, client = clientId(), dataDir = clientDataDir(client), now = Date.now() } = {}) {
  clientId(client);
  if (client !== 'codex') {
    const monitor = new ClientMonitor({ client, threadId, dataDir, settingsFile: path.join(dataDir, 'monitor-settings.json'), now: () => now });
    await monitor.initialize();
    if (threadId) monitor.config = { ...monitor.config, mode: 'thread', threadId };
    await monitor.tick(); const value = monitor.snapshot(); monitor.close();
    let window = null;
    try {
      const candidate = JSON.parse(await readFile(path.join(dataDir, 'float-status.json'), 'utf8'));
      const age = now - Date.parse(candidate.checkedAt);
      if (candidate.client === client && age >= 0 && age < 5000 && (!threadId || candidate.scope?.mode === 'thread' && candidate.threadId === threadId)) window = candidate;
    } catch {}
    return { ...value, presentation: 'desktop-float', window,
      ...(window ? { selectedId: window.threadId, usage: window.usage, limits: window.limits, observedAt: window.observedAt, ageSeconds: window.dataAgeSeconds, latestRate: window.rate, scope: window.scope, liveOutput: window.liveOutput } : {}) };
  }
  const catalog = new ThreadCatalog(codexHome ? { home: codexHome } : {});
  await catalog.refresh(true);
  let saved;
  try { saved = JSON.parse(await readFile(process.env.CODEX_PULSE_SETTINGS_FILE || path.join(dataDir, 'monitor-settings.json'), 'utf8')); } catch {}
  const selectedId = threadId || (isId(saved?.threadId) ? saved.threadId : null);
  const monitor = new Monitor({ threadId: selectedId, root: catalog.roots[0], extraRoots: catalog.roots.slice(1), catalog: async () => catalog.entries });
  await monitor.tick();
  const value = monitor.snapshot();
  let window = null;
  try {
    const candidate = JSON.parse(await readFile(path.join(dataDir, 'float-status.json'), 'utf8'));
    const age = now - Date.parse(candidate?.checkedAt);
    // An explicit request must never silently return another conversation's totals.
    const matches = !threadId || (candidate?.scope?.mode === 'thread' && (candidate.threadId || candidate.scope.threadId) === threadId);
    if (candidate?.scope && (!candidate.client || candidate.client === 'codex') && age >= 0 && age < 5000 && matches) window = candidate;
  } catch {}
  return {
    kind: 'codex-pulse', version: '0.10.0', client: 'codex', presentation: 'desktop-float',
    selectedId: window ? window.threadId : value.selectedId,
    usage: window ? window.usage : value.usage,
    limits: window ? window.limits : value.limits,
    observedAt: window ? window.observedAt : value.observedAt,
    ageSeconds: window ? window.dataAgeSeconds : value.ageSeconds,
    latestRate: window ? window.rate : value.latestRate,
    scope: window ? window.scope : { mode: 'thread', threadId: value.selectedId },
    window
  };
}
