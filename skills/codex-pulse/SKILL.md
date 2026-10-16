---
name: codex-pulse
description: 打开 Windows 本机 Codex 监控浮条，查看已上报 Token、输出 TPS、实时可见文字速度及账户额度。
---

用户要求打开监控浮条时，调用一次 `pulse_open`，沿用保存的范围、位置和大小。有可核验的本机聊天 ID 时可以传入 `threadId`；否则省略。使用当前插件工具，先检查返回结果，再简短说明是否成功。

用户明确要求 Claude Code 或 Antigravity 时，分别传入 `client: "claude-code"` / `client: "antigravity"`；不指定时保留 Codex。Claude 只有经 `claude:stream` 显式启动的会话提供实时字/秒，打开浮条不会自动创建模型请求；用户仅要求打开监控时不要启动新会话。新客户端不提供账户额度，Antigravity 暂无文字流且仅支持已定义的实验性 SQLite 用量格式；按 capabilities / coverage 报告结果，不能将窗口启动成功当成用量来源已验证。具体命令、HostPid 与覆盖边界见项目 `docs/CLIENTS.md`。

若工具尚未配置，定位当前插件安装目录，按照其 README 运行 `npm run setup:windows`；本机路径由 `npm run configure:mcp` 生成，不能套用开发者电脑的绝对路径。原生浮条仅支持 Windows；其他平台可运行核心测试与日志摘要。启动失败时报告实际错误，不能声称窗口已经显示。

主界面为附着于 Codex 窗口边缘的独立原生按钮和浮条。无需打开网页、侧栏或聊天卡片。按钮展开/收起、拖动与设置操作不经过模型；不要循环调用 MCP 刷新数据。`pulse_snapshot` 仅在用户询问统计时按需调用，指定 `threadId` 应返回该对话的数据。

Token 为官方已上报用量；默认 TPS 为输出 Token 的上报区间均速，可能包含推理 Token、等待或工具时间，不能称为瞬时生成速度。可选实时文字速度为 2 秒窗口的 Unicode 字符数/秒，不是 Token/s，不包括隐藏推理或工具输出。思考时 0 字/s 不等于零 Token 消耗。

Claude 的官方流 TPS 读取 `message_start`/`message_delta` 的累计输出计数并差分；查看 `officialTokenOutput.status`：`live` 才表示收到生成中的计数增量，`completion-only`/`completed` 仅为本次响应均速，`waiting` 表示还没有可计算的官方增量。`exactCounts` 是计数来源精确，不保证逐 Token 实时或服务端生成速度；官方普通流示例只在结束上报。全局需要切换单会话才能看此指标。不得把官方 Token 流代码测试通过称为真实客户端连续计数已验收。

监控范围可选择指定对话或本机全局。全局按逐请求明细去重，只覆盖当前电脑可读取的日志与可连接事件；不能承诺其他电脑或云端的完整覆盖。普通切换或重开保留统计起点，只有用户选择重新开始全局统计时重设。

内部桌面 IPC 具有版本校验、断线重试和日志回退，不是官方稳定插件接口。监控适配器只观察本地对话，不处理模型审批、不读取认证文件或修改客户端源码。Claude 的 `claude:stream` 是用户显式调用的独立执行入口，会发起请求或按 `--resume` 继续会话，沿用原 CLI 权限。文字只在内存转成长度并转发到终端；不要将个人运行状态、截图、日志或凭据上传 GitHub。

最小化时隐藏浮条并继续采集，Codex 完全退出时暂停采集。浮条不是全局置顶窗口。登录伴随只由用户主动开启；仅管理当前用户 Run 键中自己的 `CodexPulseCompanion` 值，禁止覆盖整个 Run 键。早期版本曾误操作 Run 键，恢复情况未知；不能声称旧值已经恢复，详见 `docs/KNOWN-ISSUES.md`。
