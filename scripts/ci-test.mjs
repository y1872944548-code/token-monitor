import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, appendFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)), report = path.join(root, 'runtime', 'test-results.xml');
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true });
const tests = (await readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(root, 'test', name));
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=' + report, ...tests], { cwd: root, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve(signal ? 1 : status ?? 1)); });
if (code && process.env.GITHUB_STEP_SUMMARY) {
  const xml = await readFile(report, 'utf8').catch(() => 'Test runner ended before producing its report.');
  const failures = [...xml.matchAll(/<testcase\b[\s\S]*?<\/testcase>/g)].map(match => match[0]).filter(value => /<(?:failure|error)\b/.test(value));
  const detail = (failures.join('\n') || xml).slice(0, 48000).replace(/`/g, "'");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n### Node test failures\n\n```xml\n' + detail + '\n```\n');
}
process.exitCode = code;
