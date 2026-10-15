import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from '../src/server.mjs';
const client = new Client({ name: 'codex-pulse-check', version: '0.1.0' });
try {
  const configured = JSON.parse(await readFile(path.join(projectRoot, '.mcp.json'), 'utf8')).mcpServers['codex-pulse'];
  await client.connect(new StdioClientTransport({ command: configured.command, args: configured.args, cwd: configured.cwd }));
  const listed = await client.listTools();
  if (!listed.tools.some(tool => tool.name === 'pulse_open') || !listed.tools.some(tool => tool.name === 'pulse_snapshot')) throw new Error('缺少监控工具');
  const threadId = process.argv.slice(2).find(arg => arg !== '--open');
  const arguments_ = threadId ? { threadId } : {};
  const shouldOpen = process.argv.includes('--open');
  if (shouldOpen) {
    const opened = await client.callTool({ name: 'pulse_open', arguments: arguments_ });
    if (opened.isError || opened.structuredContent?.presentation !== 'desktop-float') throw new Error(JSON.stringify(opened));
  }
  const sampled = await client.callTool({ name: 'pulse_snapshot', arguments: arguments_ });
  if (sampled.isError || sampled.structuredContent?.kind !== 'codex-pulse') throw new Error('摘要读取失败');
  const opener = listed.tools.find(tool => tool.name === 'pulse_open');
  if (opener._meta?.ui?.resourceUri) throw new Error('浮条入口不应打开组件面板');
  console.log(JSON.stringify({ tools: listed.tools.map(tool => tool.name),
    presentation: sampled.structuredContent.presentation,
    snapshotValidated: true, openRequested: shouldOpen,
    boundary: 'MCP协议与摘要校验通过；不代表Windows窗口或真实桌面事件已验收' }));
} finally { await client.close(); }
