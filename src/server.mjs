import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Monitor } from './monitor.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startServer({ port = 5397, threadId = null, monitor = new Monitor({ threadId }) } = {}) {
  await monitor.tick();
  const clients = new Set();
  const staticFiles = new Map([
    ['/', ['public/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
    ['/gsap.js', ['node_modules/gsap/dist/gsap.min.js', 'text/javascript; charset=utf-8']]
  ]);
  let busy = false;
  let stopping = false;
  const send = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    const actualPort = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'");
    if (!allowedHosts.includes(req.headers.host) || (req.headers.origin && !allowedHosts.map(host => `http://${host}`).includes(req.headers.origin))) {
      return send(res, 403, { error: '仅允许本机同源访问' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/api/snapshot') return send(res, 200, monitor.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (clients.size >= 10) return send(res, 429, { error: '监控窗口数量已达上限' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(monitor.snapshot())}\n\n`);
        clients.add(res); res.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST' && ['/api/select', '/api/stop'].includes(url.pathname)) {
        if (req.headers['content-type'] !== 'application/json') return send(res, 415, { error: '需要 JSON 请求' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 256) return send(res, 413, { error: '请求过大' }); }
        const input = JSON.parse(body || '{}');
        if (url.pathname === '/api/select') {
          if (busy) return send(res, 409, { error: '日志更新中，请稍后重试' });
          if (typeof input.threadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.threadId)) return send(res, 400, { error: '聊天标识无效' });
          busy = true;
          try { await monitor.select(input.threadId); return send(res, 200, monitor.snapshot()); } finally { busy = false; }
        }
        send(res, 200, { stopped: true }); setTimeout(() => close(), 100); return;
      }
      const staticFile = req.method === 'GET' ? staticFiles.get(url.pathname) : null;
      if (staticFile) { res.writeHead(200, { 'Content-Type': staticFile[1] }); res.end(await readFile(path.join(projectRoot, staticFile[0]))); return; }
      send(res, 404, { error: '未找到' });
    } catch { if (!res.headersSent) send(res, 400, { error: '请求失败，请检查聊天是否在列表中' }); else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const timer = setInterval(async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      await monitor.tick();
      const message = `data: ${JSON.stringify(monitor.snapshot())}\n\n`;
      for (const res of clients) {
        if (!res.write(message)) { clients.delete(res); res.end(); }
      }
    } finally { busy = false; }
  }, 1000);
  function close() {
    stopping = true; clearInterval(timer);
    for (const res of clients) res.end();
    server.close(); server.closeAllConnections();
  }
  return { server, close, monitor, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  const running = await startServer({ port: process.argv.includes('--port') ? Number(arg('--port')) : 5397, threadId: process.argv.includes('--thread') ? arg('--thread') : null });
  await mkdir(path.join(projectRoot, 'runtime'), { recursive: true });
  await writeFile(path.join(projectRoot, 'runtime/status.json'), JSON.stringify({ pid: process.pid, url: running.url, startedAt: new Date().toISOString() }));
  console.log(`Codex Pulse: ${running.url}`);
  process.on('SIGINT', running.close); process.on('SIGTERM', running.close);
}
