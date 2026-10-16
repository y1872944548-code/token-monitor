import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import { sampleFloat } from './float-snapshot.mjs';
import { projectRoot } from './server.mjs';
import { resolveLaunchThreadId } from './launch-target.mjs';
const exec = promisify(execFile);
const server = new McpServer({ name: 'codex-pulse', version: '0.11.0' });
const schema = { kind: z.literal('codex-pulse'), version: z.literal('0.11.0'), presentation: z.literal('desktop-float'), client: z.enum(['codex','claude-code','antigravity']),
  selectedId: z.string().uuid().nullable(), usage: z.any(), limits: z.any(), observedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(), latestRate: z.number().nullable(), scope: z.any(), window: z.any() };
async function sample(id, client = 'codex') {
  return sampleFloat({ threadId: id, client });
}
const result = value => ({ structuredContent: value, content: [{ type: 'text', text: value.client === 'codex'
  ? 'Codex 浮条摘要：已上报 Token、区间 TPS 与可见文字字/s 分开显示。'
  : `${value.clientLabel} 浮条摘要：日志 Token 与120秒上报均速；${value.liveOutput?.connected ? '已连接文字流（字/s）' : '未连接文字流'}。官方 Token 流状态：${value.officialTokenOutput?.status || 'unsupported'}；live 是收到生成中的官方计数增量，completion-only 仅表示结束上报均速，不等于逐Token实时。用量覆盖：${value.scope.coverage}。` }] });
server.registerTool('pulse_open', {
  title: '客户端监控浮条', description: '打开 Codex、Claude Code 或 Antigravity 的原生监控浮条；client 指定客户端，沿用各自保存的范围。Claude 的实时字速需要另用 claude:stream 启动会话；此工具只打开监控，不发起模型请求。',
  inputSchema: { threadId: z.string().uuid().optional(), client: z.enum(['codex','claude-code','antigravity']).default('codex'), hostPid: z.number().int().positive().max(4294967295).optional() }, outputSchema: schema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}, async ({ threadId, client, hostPid }) => {
  try {
    if (process.platform !== 'win32') throw new Error('原生浮条需要 Windows 10/11；当前平台可运行统计测试和读取日志摘要。');
    const first = await sample(threadId, client);
    const launchId=resolveLaunchThreadId(threadId,first);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'scripts/start-float.ps1'), '-NodePath', process.execPath, '-Client', client];
    if (hostPid) args.push('-HostPid', String(hostPid));
    if (launchId) args.push('-ThreadId', launchId);
    await exec('powershell.exe', args, { windowsHide: true, timeout: 30000 });
    return result(await sample(undefined, client));
  } catch(error) { return { isError: true, content: [{ type: 'text', text: `浮条启动失败：${error.message}` }] }; }
});
server.registerTool('pulse_snapshot', { description: '读取指定客户端的浮条与日志摘要，不循环调用模型。', inputSchema: { threadId: z.string().uuid().optional(), client: z.enum(['codex','claude-code','antigravity']).default('codex') }, outputSchema: schema,
  annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ threadId, client }) => result(await sample(threadId, client)));
await server.connect(new StdioServerTransport());
