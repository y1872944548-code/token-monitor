const url = 'http://127.0.0.1:5397';
let status;
try { const response = await fetch(`${url}/api/snapshot`, { signal: AbortSignal.timeout(1500) }); status = await response.json(); }
catch { console.log('监控当前未运行'); process.exit(0); }
if (status.kind !== 'codex-pulse') throw new Error('5397不是本项目服务，停止操作已取消');
const stopped = await fetch(`${url}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
if (!stopped.ok) throw new Error('停止失败');
let closed = false;
for (let attempt = 0; attempt < 15; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  try { await fetch(`${url}/api/snapshot`, { signal: AbortSignal.timeout(500) }); }
  catch { closed = true; break; }
}
if (!closed) throw new Error('服务仍在运行，不重复启动');
console.log('本项目服务已停止；接下来运行 node scripts/check-mcp.mjs 启动最终代码。');
