import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './server.mjs';
export const WIDGET_URI = 'ui://codex-pulse/v0.2/panel.html';
export async function widgetHtml() {
  const [html, css, gsap, bridge, app] = await Promise.all([
    'public/index.html', 'public/style.css', 'node_modules/gsap/dist/gsap.min.js', 'public/host-bridge.js', 'public/app.js'
  ].map(file => readFile(path.join(projectRoot, file), 'utf8')));
  const script = text => '<script>' + text.replace(/<\/script/gi, '<\\/script') + '</script>';
  return html.replace(/<link rel="stylesheet"[^>]+>/, () => '<style>' + css + '</style>')
    .replace(/<script defer[^>]+><\/script>/g, '').replace('<body>', '<body class="compact">')
    .replace('CODEX / LOCAL TELEMETRY', 'CODEX / PLUGIN PANEL')
    .replace('<h1>运行，尽在眼前。</h1>', '<h1>Codex 运行监控</h1>')
    .replace('>小窗模式</button>', '>完整面板</button>')
    .replace('>关闭监控服务</button>', '>停止此组件采集</button>')
    .replace('</body>', () => script(gsap) + script(bridge) + script(app) + '</body>');
}
