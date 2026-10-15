'use strict';
const $ = id => document.getElementById(id);
const format = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
const shortTime = time => new Date(time).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const svgNS = 'http://www.w3.org/2000/svg';
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
let state = null, paused = false, signature = '', connected = false, selectionSequence = 0;
const dots = new Map();
function element(name, attrs, text) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function draw(id, emptyId, points, field, color, now) {
  const svg = $(id), period = Number($('range').value) * 1000;
  const cutoff = now - period;
  // Carry a preceding observation to the boundary; never extrapolate a speed after its observation.
  const before = [...points].reverse().find(point => point.time < cutoff);
  const visible = points.filter(point => point.time >= cutoff && point.time <= now);
  if (before && field !== 'rate') visible.unshift({ ...before, time: cutoff });
  const value = point => field === 'rate' ? point.rate : point.usage[field];
  const values = visible.filter(point => value(point) !== null && value(point) !== undefined);
  $(emptyId).hidden = values.length > 0;
  const max = Math.max(1, ...values.map(value)), height = 159;
  const x = time => 65 + Math.max(0, Math.min(1, (time - cutoff) / period)) * 802;
  const y = amount => 22 + height * (1 - amount / (max * 1.12));
  svg.replaceChildren();
  for (let n = 0; n < 4; n++) {
    const yy = 22 + n * height / 3;
    svg.append(element('line', { x1: 65, x2: 867, y1: yy, y2: yy, class: 'grid' }));
    const val = max * 1.12 * (1 - n / 3);
    svg.append(element('text', { x: 52, y: yy + 4, 'text-anchor': 'end' }, val >= 1000 ? `${format(val / 1000)}k` : format(val)));
  }
  for (let n = 0; n < 3; n++) svg.append(element('text', { x: 65 + n * 401, y: 210, 'text-anchor': n === 0 ? 'start' : n === 2 ? 'end' : 'middle' }, shortTime(cutoff + n * period / 2)));
  let trace = '', lastValid = false;
  for (const point of visible) {
    const amount = value(point);
    if (amount === null || amount === undefined) { lastValid = false; continue; }
    trace += `${lastValid ? ' L' : ' M'}${x(point.time).toFixed(2)},${y(amount).toFixed(2)}`;
    lastValid = true;
  }
  svg.append(element('path', { d: trace, class: 'trace', stroke: color }));
  if (values.length === 0) return;
  const newest = values.at(-1), cx = x(newest.time), cy = y(value(newest));
  const halo = element('circle', { r: 10, fill: color, opacity: '.1' });
  const dot = element('circle', { r: 4.5, fill: color, stroke: '#182328', 'stroke-width': 2 });
  dot.append(element('title', {}, `${shortTime(newest.time)} · ${format(value(newest))}${field === 'rate' ? ' Token/s' : ' Token'}`));
  svg.append(halo, dot);
  let animated = dots.get(id);
  if (!animated) { animated = { x: cx, y: cy }; dots.set(id, animated); }
  const renderDot = () => { for (const node of [halo, dot]) { node.setAttribute('cx', animated.x); node.setAttribute('cy', animated.y); } };
  renderDot();
  gsap.to(animated, { x: cx, y: cy, duration: motion.matches ? 0 : .3, ease: 'none', overwrite: true, onUpdate: renderDot });
}
function updateQuota(value, now) {
  $('quotaRows').replaceChildren();
  $('quotaAge').textContent = value ? `账户共享 · ${shortTime(value.observedAt)} 记录` : '暂无本机额度记录';
  for (const [key, label] of [['primary', '短期窗口'], ['secondary', '长期窗口']]) {
    const quota = value?.[key];
    if (!quota || quota.usedPercent === null) continue;
    const row = document.createElement('div'); row.className = 'quota-row';
    const left = document.createElement('div');
    const duration = quota.windowMinutes;
    left.textContent = duration === 300 ? '5 小时额度' : duration === 10080 ? '每周额度' : duration ? `${format(duration / 60)} 小时额度` : label;
    const small = document.createElement('small');
    small.textContent = quota.resetsAt ? (quota.resetsAt * 1000 <= now ? '已到重置时间，待更新' : `重置 ${new Date(quota.resetsAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`) : '重置时间未知';
    left.append(small);
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('div'); fill.className = 'fill'; bar.append(fill);
    gsap.set(fill, { scaleX: Math.max(0, Math.min(100, quota.usedPercent)) / 100 });
    const percent = document.createElement('strong'); percent.textContent = `已用 ${format(quota.usedPercent)}%`;
    row.append(left, bar, percent); $('quotaRows').append(row);
  }
}
function render(value) {
  if (paused) return;
  const sessionSignature = value.sessions.map(session => session.id).join(',');
  if (signature !== sessionSignature) {
    $('session').replaceChildren(...value.sessions.map(session => {
      const option = document.createElement('option'); option.value = session.id;
      option.textContent = `${session.id.slice(0, 8)}…${session.id.slice(-8)}`; return option;
    })); signature = sessionSignature;
  }
  if ($('session').value !== value.selectedId) { $('session').value = value.selectedId; gsap.killTweensOf([...dots.values()]); dots.clear(); }
  const usage = value.usage;
  for (const [id, key] of [['total', 'total_tokens'], ['input', 'input_tokens'], ['output', 'output_tokens'], ['cached', 'cached_input_tokens'], ['reasoning', 'reasoning_output_tokens']]) $(id).textContent = format(usage?.[key]);
  const stale = value.ageSeconds !== null && value.ageSeconds > 15;
  $('rate').textContent = stale ? '—' : format(value.latestRate);
  $('interval').textContent = value.latestRate === null ? '等待两个有效观测点' : `${stale ? '上一观测 ' + format(value.latestRate) + ' tok/s · ' : ''}${format(value.rateIntervalSeconds)} 秒区间平均`;
  $('model').textContent = value.model || '模型未知';
  $('activity').textContent = ({ running: stale ? '任务未结束 · 等待日志更新' : '任务进行中', completed: '本轮已结束', interrupted: '已中断', unknown: '状态未知' })[value.status] || '状态未知';
  $('age').textContent = value.ageSeconds === null ? '暂无用量观测' : `最新观测距今 ${format(value.ageSeconds)} 秒`;
  $('error').textContent = value.error || (value.skippedBytes ? '图表仅保留最近日志片段；累计用量按日志报告的整段聊天总量显示。' : '');
  draw('usageChart', 'usageEmpty', value.points, $('metric').value, '#91efbb', value.now);
  draw('rateChart', 'rateEmpty', value.points, 'rate', '#85cafa', value.now);
  updateQuota(value.limits, value.now);
}
const source = window.PULSE_HOST ? window.PULSE_HOST.connect() : new EventSource('/api/events');
source.onmessage = event => { connected = true; state = JSON.parse(event.data); $('light').className = 'live'; $('connection').textContent = paused ? '画面已暂停 · 仍在采集' : '本地连接正常'; render(state); };
source.onerror = event => { connected = false; $('light').className = ''; $('connection').textContent = window.PULSE_HOST && event?.message ? event.message : '连接中断 · 正在重连'; $('rate').textContent = '—'; };
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? '继续显示' : '暂停画面'; if (paused) { for (const dot of dots.values()) gsap.killTweensOf(dot); } else if (state) render(state); $('connection').textContent = connected ? paused ? '画面已暂停 · 仍在采集' : '本地连接正常' : '连接中断'; };
for (const id of ['range', 'metric']) $(id).onchange = () => { for (const dot of dots.values()) gsap.killTweensOf(dot); dots.clear(); if (state) render(state); };
$('compact').onclick = () => { document.body.classList.toggle('compact'); $('compact').textContent = document.body.classList.contains('compact') ? '完整面板' : '小窗模式'; };
$('session').onchange = async () => {
  const requestSequence = ++selectionSequence;
  try {
    let result;
    if (window.PULSE_HOST) result = await window.PULSE_HOST.select($('session').value);
    else { const response = await fetch('/api/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: $('session').value }) }); result = await response.json(); if (!response.ok) throw new Error(result.error); }
    if (requestSequence !== selectionSequence) return;
    for (const dot of dots.values()) gsap.killTweensOf(dot); dots.clear(); state = result; render(state);
  }
  catch (error) { if (requestSequence === selectionSequence) $('error').textContent = error.message; }
};
$('stop').onclick = async () => {
  try {
    if (!window.PULSE_HOST) { const response = await fetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (!response.ok) throw new Error('停止失败'); }
    source.close(); connected = false; $('light').className = ''; $('connection').textContent = window.PULSE_HOST ? '此组件采集已停止' : '监控服务已关闭'; $('rate').textContent = '—';
  }
  catch (error) { $('error').textContent = error.message; }
};
window.addEventListener('pagehide', () => { source.close(); for (const dot of dots.values()) gsap.killTweensOf(dot); });
