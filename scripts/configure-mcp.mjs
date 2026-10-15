import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Generate machine-specific paths locally; never commit another user's paths.
export async function configureMcp(root = fileURLToPath(new URL('../', import.meta.url))) {
  const file = path.join(root, '.mcp.json');
  let config = {};
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    throw new Error('Invalid .mcp.json; existing configuration was preserved');
  }
  config.mcpServers = { ...config.mcpServers, 'codex-pulse': {
    command: process.execPath, args: [path.join(root, 'src', 'float-mcp.mjs')], cwd: root
  } };
  await writeFile(file, JSON.stringify(config, null, 2) + '\n');
  return config.mcpServers['codex-pulse'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await configureMcp();
  console.log('Generated local .mcp.json for this checkout. Do not commit it.');
}
