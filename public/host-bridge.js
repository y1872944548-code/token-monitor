// MCP Apps transport: no HTTP, localhost, or external asset requests.
(() => {
  let sequence = 0, selectedId = null, stream = null, timer = null, closed = false, initialized = null, generation = 0;
  const pending = new Map();
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('宿主未响应监控组件')); }, 5000);
    pending.set(id, { resolve, reject, timeout });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
  const publish = value => {
    if (!value || value.kind !== 'codex-pulse' || closed) return;
    selectedId = value.selectedId; stream?.onmessage?.({ data: JSON.stringify(value) });
  };
  const handleMessage = event => {
    if (event.source !== window.parent || closed) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id); clearTimeout(request.timeout); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || '宿主调用失败')); else request.resolve(message.result);
    } else if (message.method === 'ui/notifications/tool-input') {
      const id = message.params?.arguments?.threadId ?? message.params?.threadId;
      if (id && !selectedId) selectedId = id;
    } else if (message.method === 'ui/notifications/tool-result') publish(message.params?._meta?.pulseData);
    else if (message.method === 'ui/resource-teardown') {
      window.PULSE_HOST.close();
      if (message.id !== undefined) window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    }
  };
  window.addEventListener('message', handleMessage);
  async function ready() {
    initialized ||= rpc('ui/initialize', {
      appInfo: { name: 'codex-pulse', version: '0.2.0' }, appCapabilities: {}, protocolVersion: '2026-01-26'
    }).then(() => window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*'))
      .catch(error => { initialized = null; throw error; });
    return initialized;
  }
  async function data(id) {
    await ready();
    const response = await rpc('tools/call', { name: 'pulse_data', arguments: id ? { threadId: id } : {} });
    if (response.isError) throw new Error(response.content?.find(item => item.type === 'text')?.text || '指标读取失败');
    const value = response._meta?.pulseData;
    if (!value) throw new Error('宿主没有传递组件指标');
    return value;
  }
  async function poll() {
    const startedGeneration = generation;
    try { const value = await data(selectedId); if (startedGeneration === generation) publish(value); }
    catch (error) { if (!closed) stream?.onerror?.({ message: error.message }); }
    if (!closed) timer = setTimeout(poll, 1000);
  }
  window.PULSE_HOST = {
    async display(mode) { await ready(); return rpc('ui/request-display-mode', { mode }); },
    connect() {
      stream = { onmessage: null, onerror: null, close: () => window.PULSE_HOST.close() };
      queueMicrotask(poll); return stream;
    },
    async select(id) {
      const selectedGeneration = ++generation, priorId = selectedId;
      selectedId = id;
      try { const value = await data(id); if (selectedGeneration === generation) publish(value); return value; }
      catch (error) { if (selectedGeneration === generation) selectedId = priorId; throw error; }
    },
    close() {
      closed = true; clearTimeout(timer); window.removeEventListener('message', handleMessage);
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('组件已关闭')); }
      pending.clear();
    }
  };
})();
