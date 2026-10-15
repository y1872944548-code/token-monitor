import { ClientMonitor } from '../src/client-monitor.mjs';
import { ThreadCatalog } from '../src/thread-catalog.mjs';

const catalog = new ThreadCatalog(); await catalog.refresh(true);
const clients = [{ client: 'codex', localSessions: catalog.entries.length, indexAvailable: !catalog.restricted }];
for (const client of ['claude-code', 'antigravity']) {
  const monitor = new ClientMonitor({ client });
  try {
    await monitor.initialize(); await monitor.tick(); const value = monitor.snapshot();
    clients.push({ client, localSessions: monitor.catalog.entries.length, compatibleUsageFound: value.capabilities.tokens,
      coverage: value.scope.coverage, readErrors: value.scope.readErrors, unsupportedFiles: value.capabilities.unsupportedFiles,
      supportedFormat: client === 'claude-code' ? 'projects/<project>/<session>.jsonl' : 'gen_metadata SQLite with embedded generation timestamp' });
  } finally { monitor.close(); }
}
// No paths, conversation IDs, text, credentials or numeric account usage in exports.
console.log(JSON.stringify({ platform: process.platform, node: process.version, clients }, null, 2));
