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
const server = new McpServer({ name: 'codex-pulse', version: '0.8.1' });
const schema = { kind: z.literal('codex-pulse'), version: z.literal('0.8.1'), presentation: z.literal('desktop-float'),
  selectedId: z.string().uuid().nullable(), usage: z.any(), limits: z.any(), observedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(), latestRate: z.number().nullable(), scope: z.any(), window: z.any() };
async function sample(id) {
  return sampleFloat({ threadId: id });
}
const result = value => ({ structuredContent: value, content: [{ type: 'text', text: '可缩放流光浮条；Windows桌面事件流统计实时可见文字字/s，官方Token用量与区间tok/s分开显示。不是精确逐Token总消耗。' }] });
server.registerTool('pulse_open', {
  title: 'Codex固定小浮条', description: '打开已保存范围的Codex浮条。点设置按钮或右键可选指定聊天或本机全局本次统计，Token与速度/曲线共同切换；不是精确逐Token总消耗。无网页/侧栏/聊天卡片。',
  inputSchema: { threadId: z.string().uuid().optional() }, outputSchema: schema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}, async ({ threadId }) => {
  try {
    if (process.platform !== 'win32') throw new Error('原生浮条需要 Windows 10/11；当前平台可运行统计测试和读取日志摘要。');
    const first = await sample(threadId);
    const launchId=resolveLaunchThreadId(threadId,first);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'scripts/start-float.ps1'), '-NodePath', process.execPath];
    if (launchId) args.push('-ThreadId', launchId);
    await exec('powershell.exe', args, { windowsHide: true, timeout: 30000 });
    return result(await sample(launchId));
  } catch(error) { return { isError: true, content: [{ type: 'text', text: `浮条启动失败：${error.message}` }] }; }
});
server.registerTool('pulse_snapshot', { description: '读取一次固定浮条与日志摘要，不循环调用模型。', inputSchema: { threadId: z.string().uuid().optional() }, outputSchema: schema,
  annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ threadId }) => result(await sample(threadId)));
await server.connect(new StdioServerTransport());
