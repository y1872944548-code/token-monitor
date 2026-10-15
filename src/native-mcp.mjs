import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Monitor } from './monitor.mjs';
import { widgetHtml, WIDGET_URI } from './widget.mjs';

const count = z.number().nonnegative().nullable();
const quotaWindow = z.object({ usedPercent: count, windowMinutes: count, resetsAt: count }).nullable();
const outputSchema = {
  kind: z.literal('codex-pulse'), version: z.literal('0.2.0'), presentation: z.literal('mcp-app'),
  now: z.number(), selectedId: z.string().uuid().nullable(), error: z.string().nullable(), skippedBytes: z.number().nonnegative(),
  usage: z.object({ input_tokens: count, cached_input_tokens: count, output_tokens: count, reasoning_output_tokens: count, total_tokens: count }).nullable(),
  limits: z.object({ limitId: z.string(), primary: quotaWindow, secondary: quotaWindow, observedAt: z.number() }).nullable(),
  model: z.string().nullable(), status: z.string(), lastActivity: z.number().nullable(), latestRate: count,
  rateIntervalSeconds: z.number().nullable(), observedAt: z.number().nullable(), ageSeconds: count
};

export function createMcpServer({ root } = {}) {
  const server = new McpServer({ name: 'codex-pulse', version: '0.2.0' });
  const readers = new Map(), pending = new Map();
  async function read(threadId) {
    const key = threadId || 'recent';
    const prior = pending.get(key) || Promise.resolve();
    const operation = prior.catch(() => {}).then(async () => {
      let reader = readers.get(key);
      if (!reader) {
        reader = new Monitor({ root, threadId });
        await reader.discover();
        if (threadId && !reader.sessions.some(session => session.id === threadId)) throw new Error('聊天不在最近本机日志列表中');
        if (readers.size >= 12) readers.delete(readers.keys().next().value);
        readers.set(key, reader);
      }
      await reader.tick();
      return { ...reader.snapshot(), version: '0.2.0', presentation: 'mcp-app' };
    });
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  const error = value => ({ isError: true, content: [{ type: 'text', text: value.message }] });
  const summary = value => {
    const { points, sessions, ...rest } = value;
    return { content: [{ type: 'text', text: '本机真实记录，速度为观测区间平均，账户额度共享。' }], structuredContent: rest };
  };
  server.registerResource('codex-pulse-panel', WIDGET_URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{ uri: WIDGET_URI, mimeType: 'text/html;profile=mcp-app', text: await widgetHtml(),
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen', 'pip'] },
        'openai/widgetDescription': '本机运行监控组件，直接在插件面板持续显示Token与账户额度。' } }]
  }));
  server.registerTool('pulse_open', {
    title: 'Codex运行监控',
    description: '在宿主聊天内打开运行监控插件组件。组件每秒直接读本机日志；不打开网页地址，不启动HTTP服务，不调用推理模型。',
    inputSchema: { threadId: z.string().uuid().optional() },
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } }
  }, async ({ threadId }) => {
    try { const value = await read(threadId); return { ...summary(value), _meta: { pulseData: value } }; }
    catch (value) { return error(value); }
  });
  server.registerTool('pulse_data', {
    description: '仅供监控组件自动刷新和切换本机聊天；完整图表数据放组件私有元数据。',
    inputSchema: { threadId: z.string().uuid().optional() },
    outputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true }
  }, async ({ threadId }) => {
    try { const value = await read(threadId); return { ...summary(value), _meta: { pulseData: value } }; }
    catch (value) { return error(value); }
  });
  server.registerTool('pulse_snapshot', {
    description: '读取一次运行监控摘要。组件自己刷新，无需模型反复调用此工具。',
    inputSchema: { threadId: z.string().uuid().optional() }, outputSchema, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ threadId }) => {
    try { return summary(await read(threadId)); } catch (value) { return error(value); }
  });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await createMcpServer().connect(new StdioServerTransport());
