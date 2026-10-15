'use strict';
const el = id => document.getElementById(id);
const compact = value => value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const numeric = value => value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
let latest = null, paused = false;
const dot = { x: 98, y: 15 };
function render(data) {
  if (paused) return;
  const stale = data.ageSeconds === null || data.ageSeconds > 15;
  el('total').textContent = compact(data.usage?.total_tokens);
  el('tokenReading').title = `当前聊天累计输入+输出，含重复上下文与缓存；输入 ${data.usage?.input_tokens ?? '未知'}，缓存 ${data.usage?.cached_input_tokens ?? '未知'}，输出 ${data.usage?.output_tokens ?? '未知'}；不等于人民币费用`;
  el('speed').textContent = stale ? '待更新' : numeric(data.latestRate);
  const age = data.ageSeconds == null ? '未知' : numeric(data.ageSeconds) + '秒';
  el('signal').title = `最近真实记录距今${age}；速度为观测区间平均，包含工具和等待`;
  el('signal').className = 'signal' + (data.error || stale ? '' : ' live');
  for (const [id, key] of [['short', 'primary'], ['week', 'secondary']]) {
    const window = data.limits?.[key];
    el(id).textContent = window?.usedPercent == null ? '—' : numeric(Math.max(0, 100 - window.usedPercent)) + '%';
    el(id === 'short' ? 'shortReading' : 'weekReading').title = `账户共享额度；记录时间 ${data.limits?.observedAt ? new Date(data.limits.observedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知'}`;
  }
  const points = data.points.filter(point => point.rate !== null && point.time >= data.now - 600000).slice(-60);
  if (!points.length) { el('trace').setAttribute('d', ''); el('point').style.display = 'none'; return; }
  const maximum = Math.max(1, ...points.map(point => point.rate));
  const start = data.now - 600000;
  const xy = point => ({ x: 2 + Math.min(1, Math.max(0, (point.time - start) / 600000)) * 96, y: 27 - point.rate / maximum * 24 });
  el('trace').setAttribute('d', points.map((point, i) => { const p = xy(point); return `${i ? 'L' : 'M'}${p.x},${p.y}`; }).join(' '));
  el('point').style.display = '';
  const p = xy(points.at(-1));
  gsap.to(dot, { ...p, duration: reduce.matches ? 0 : .2, ease: 'none', overwrite: true, onUpdate() { el('point').setAttribute('cx', dot.x); el('point').setAttribute('cy', dot.y); } });
}
async function placement() {
  try {
    let response = await window.PULSE_HOST.display('pip');
    if (response.mode !== 'pip') response = await window.PULSE_HOST.display('inline');
    document.body.dataset.actualMode = response.mode || 'unknown';
    el('placement').textContent = ['pip', 'inline'].includes(response.mode) ? '' : `浮条与内联均未启用；宿主实际返回 ${response.mode || '未知'}`;
  } catch (error) { document.body.dataset.actualMode = 'unsupported'; el('placement').textContent = `本机宿主未提供浮条模式：${error.message}`; }
}
const stream = window.PULSE_HOST.connect();
stream.onmessage = message => { latest = JSON.parse(message.data); render(latest); };
stream.onerror = event => { el('signal').className = 'signal'; el('speed').textContent = '待更新'; el('signal').title = event?.message || '连接断开'; };
el('pin').onclick = placement;
el('pause').onclick = () => { paused = !paused; el('pause').textContent = paused ? '▶' : 'Ⅱ'; el('pause').setAttribute('aria-label', paused ? '恢复监控画面' : '暂停监控画面'); if (paused) gsap.killTweensOf(dot); else if (latest) render(latest); };
window.addEventListener('pagehide', () => { stream.close(); gsap.killTweensOf(dot); });
placement();
