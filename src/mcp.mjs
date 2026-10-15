import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './server.mjs';

const url = 'http://127.0.0.1:5397';
const server = new McpServer({ name: 'codex-pulse', version: '0.1.0' });
async function snapshot() {
  const response = await fetch(`${url}/api/snapshot`, { signal: AbortSignal.timeout(2000) });
  const value = await response.json();
  if (!response.ok || value.kind !== 'codex-pulse') throw new Error('监控未启动或端口被其他服务占用');
  return value;
}
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
server.registerTool('pulse_open', {
  description: '启动本机只读运行监控，返回可在 Codex 浏览器侧栏中打开的地址。监控自动刷新，不调用模型。',
  inputSchema: { threadId: z.string().uuid().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}, async ({ threadId }) => {
  try {
    let value;
    try { value = await snapshot(); } catch {
      await mkdir(path.join(projectRoot, 'runtime'), { recursive: true });
      const log = await open(path.join(projectRoot, 'runtime/server.log'), 'a');
      try {
        const child = spawn(process.execPath, [path.join(projectRoot, 'src/server.mjs'), ...(threadId ? ['--thread', threadId] : [])], {
          cwd: projectRoot, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd]
        });
        child.on('error', () => {}); child.unref();
      } finally { await log.close(); }
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        try { value = await snapshot(); break; } catch { /* bounded readiness wait */ }
      }
      if (!value) throw new Error('启动失败，请查看插件 runtime/server.log；不会替换已有服务');
    }
    if (threadId && value.selectedId !== threadId) {
      const response = await fetch(`${url}/api/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('无法选择该聊天；请选择监控列表中的本机聊天');
      value = await response.json();
    }
    return result({ url, selectedId: value.selectedId, note: '每秒监听日志。速度为观测间隔平均输出 Token/s；账户额度共享。' });
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
server.registerTool('pulse_snapshot', {
  description: '读取一次运行监控摘要；图表自动刷新无需重复调用此工具。', inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async () => {
  try { const value = await snapshot(); const { points, sessions, ...summary } = value; return result(summary); }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
