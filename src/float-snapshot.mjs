import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Monitor } from './monitor.mjs';
import { ThreadCatalog, isId } from './thread-catalog.mjs';
import { projectRoot } from './server.mjs';

export async function sampleFloat({ threadId, codexHome, dataDir = process.env.CODEX_PULSE_DATA_DIR || path.join(projectRoot, 'runtime'), now = Date.now() } = {}) {
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
    if (candidate?.scope && age >= 0 && age < 5000 && matches) window = candidate;
  } catch {}
  return {
    kind: 'codex-pulse', version: '0.8.1', presentation: 'desktop-float',
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
