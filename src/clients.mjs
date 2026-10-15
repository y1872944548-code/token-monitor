import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENTS = Object.freeze({ codex: 'Codex', 'claude-code': 'Claude Code', antigravity: 'Antigravity' });
export function clientId(value = process.env.CODEX_PULSE_CLIENT || 'codex') {
  if (!Object.hasOwn(CLIENTS, value)) throw new Error('Unsupported monitoring client');
  return value;
}
export function clientDataDir(client = clientId(), base = process.env.CODEX_PULSE_DATA_DIR || fileURLToPath(new URL('../runtime/', import.meta.url))) {
  clientId(client);
  return process.env.CODEX_PULSE_CLIENT_DATA_DIR || (client === 'codex' ? base : path.join(base, 'clients', client));
}
export function clientSettingsFile(client = clientId()) {
  return client === 'codex' && process.env.CODEX_PULSE_SETTINGS_FILE || path.join(clientDataDir(client), 'monitor-settings.json');
}
export function clientHome(client) {
  clientId(client);
  if (client === 'claude-code') return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  if (client === 'antigravity') return path.resolve(process.env.CODEX_PULSE_ANTIGRAVITY_HOME || path.join(process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini'), 'antigravity'));
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}
