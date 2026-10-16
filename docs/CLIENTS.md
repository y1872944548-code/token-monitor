# Claude Code 与 Antigravity

现有 Codex 功能保留。新客户端共用浮条、按钮和曲线，各自使用独立的数据源、设置目录、统计起点与单例进程。

## Windows 启动

首次在项目目录执行 `npm run setup:windows`，然后按需启动：

```powershell
npm run start:claude
npm run start:antigravity
```

也可以告诉已加载本项目 MCP 工具的助手“打开 Claude Code 监控”或“打开 Antigravity 监控”，让其调用 `pulse_open` 并分别传入 `client: "claude-code"` 或 `client: "antigravity"`。不传 client 时继续使用 Codex。

首次仅显示按钮：

```powershell
npm run start:claude -- -ButtonOnly
npm run start:antigravity -- -ButtonOnly
```

各客户端程序和设置默认位于 `runtime/clients/<client>/`，Codex 仍使用原来的 `runtime/`。关闭某个监控不会停止其他客户端的监控。`-EnableCompanion` 为主动启用的登录伴随选项；新客户端仅管理 `CodexPulseCompanion-claude-code` / `CodexPulseCompanion-antigravity`，不覆盖 Codex 原有值或其他软件的值。

## Claude Code

第一版支持 Windows 本机 Claude Code，包括 Windows 终端或 VS Code 内置终端中的原生 CLI。读取 `~/.claude/projects/<project>/<session UUID>.jsonl`；`CLAUDE_CONFIG_DIR` 可以指定 Claude 配置根目录。不会扫描认证文件、用户目录中的其他项目文件或 WSL 文件系统。

只解析 assistant 消息的用量、消息 ID 和报告时间；文本不进入快照或诊断导出。同一 assistant ID 的内容块和重复记录去重，后续用量增长合并。输入总量为新输入＋缓存读取＋缓存创建，输出使用报告的 output_tokens，缓存不再重复加入总量。子代理目录暂不单独扫描，因此不是整个账户的完整用量账单。

按钮优先通过原生 `claude.exe` 的父进程关系识别终端/VS Code，或匹配终端的 Claude Code 标题。npm 旧版启动、宿主进程隔离或多个窗口可能让自动关联不足；可以显式选择窗口进程：

```powershell
Get-Process WindowsTerminal,Code -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,MainWindowTitle
npm run start:claude -- -HostPid 12345
```

把 12345 换成目标窗口所属进程 ID。该绑定只用于当前启动，不写入登录伴随命令，避免登录后 PID 变化。多个窗口由同一进程管理时，优先匹配可见窗口；统计范围仍由设置中选定的会话决定，不能将窗口识别视为聊天标签页的精确匹配。

WSL 和 VS Code 专用扩展尚不在第一版的数据源覆盖范围。VS Code 内置终端运行原生 CLI 与专用扩展是不同入口。

### Claude 实时文字流（0.10.0）

已安装并登录 Claude Code 后，在本项目目录运行：

```powershell
npm run claude:stream -- --cwd "C:\你的项目" "介绍这个项目的结构"
```

入口以 Claude CLI 的 `--print --verbose --output-format stream-json --include-partial-messages` 启动一次非交互请求，继承已有登录、项目设置及工具权限规则，不添加跳过权限检查的选项；不等同于原来的交互终端。终端持续显示可见回复，Windows 自动打开监控并临时选择此次会话，不覆盖之前保存的监控范围。Claude 浮条首次默认选择字/秒；已保存的速度偏好保留，可在设置中切换“字/秒 · 实时文字”。

终端会输出会话 UUID；之后可继续同一会话：

```powershell
npm run claude:stream -- --cwd "C:\你的项目" --resume "替换为会话UUID" "继续解释入口文件"
```

可用 `--model NAME` 选择模型、`--no-monitor` 只在终端流式运行。Windows 自动发现原生 `claude.exe`；npm 旧版安装可通过 `--claude-path "C:\...\@anthropic-ai\claude-code\cli.js"` 指定实际 JS 入口，由当前 Node 执行，不使用 shell 执行 `.cmd`。运行 `npm run claude:stream -- --help` 查看参数。也可从目标项目目录直接运行本插件的 `scripts/claude-stream.mjs`，或通过管道提供提示词。

流事件依据 [Anthropic 官方 SDK 的 CLI 参数构造](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py) 与 [StreamEvent 定义](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py)。只统计本会话主代理 `text_delta` 和 text 块的初始可见文字；事件 UUID 去重，完整 assistant/result 快照不重复计数。隐藏推理、工具 JSON、子代理内容不计入。仅在终端转发文字；监控侧 `runtime/clients/claude-code/streams/<UUID>.json` 只保存字符计数及时间桶，不写提示词、回复或原始事件。

计数每 200ms 写入，浮条 feed 每 500ms 采样；速度为最近 2 秒 Unicode 字符数/2，单位是字/s。一个事件可能包含多个 Token，不能把事件数或字符数当作精确 TPS。没有流事件时不会把完成后的整段回复冒充实时速度；流结束/心跳过期后自动回退到已有日志 TPS。累计 Token 仍只用会话日志，不重复叠加流数据。普通 `start:claude` 仍可监控已有会话用量，但不能获取它们未对外提供的文字流。

这个入口不自动下载 Claude、不修改 Claude 配置、不代替工具审批，也不在安装/检查阶段发送模型请求。Linux 可使用 `--no-monitor` 测试 CLI 接入；Windows 浮条不因此覆盖 WSL。

## Antigravity（实验性）

按 Google 官方 Windows 客户端 `Antigravity.exe` 识别窗口。读取 `~/.gemini/antigravity/*.db` 与 `conversations/*.db` 中 UUID 命名的会话数据库；`GEMINI_CLI_HOME` 替换 `.gemini` 根目录，或用 `CODEX_PULSE_ANTIGRAVITY_HOME` 直接指定 Antigravity 数据目录。

支持 ordinary `gen_metadata(idx,data)` 表和嵌入式生成时间戳 `chatModel.#9.#4` 的数值记录。仅解码用量字段，不解码聊天正文。SQLite 以只读模式打开，不复制数据库或修改记录；正常 WAL 读取可能使用 SQLite 的共享内存协调机制。

格式依据来自公开的第三方本机格式研究，**不是 Google 的稳定公开接口**：

- [Tokscale 的固定版本解析说明](https://github.com/junhoyeo/tokscale/blob/62ca1eb1677556972ba963fdfa3a41ab23c1eb4b/crates/tokscale-core/src/sessions/antigravity_cli.rs)
- [CodexBar 的本机格式与覆盖边界说明](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md#local-token-history)

其中 usage field 1 为模型枚举，不能算 Token；使用 field 2 的新输入、field 5 的缓存读取和 field 3 的总输出。对 field 9/10 仅校验合计，不猜测哪一项是可见/推理输出。缺少总输出时，两项均存在且有效才能使用其合计。缺少嵌入时间戳、矛盾计数或不认识的布局不会用文件修改时间补齐。

旧版仅提供 `.pb` 的记录、需要其他时间戳恢复方式的数据库以及未来未知格式暂不支持。发现这类记录会显示未支持/未知状态，不能声称已经完成其用量采集。版本号不需要用户预先填写，兼容性按实际文件与字段判断；这不等于支持所有版本。

实时文字流尚未接入。当前能核实的公开本机格式研究主要提供用量/额度，不足以证明桌面客户端存在可用的增量文字接口；因此未将 Antigravity 的轮询数据标为实时字速，也没有复用 Claude 的协议去猜测 Antigravity。后续需要依据实际客户端可验证的扩展事件或官方流式接口实现独立适配器。

## 指标与覆盖

- 新客户端的 TPS 为**最近 120 秒报告的输出 Token / 120 秒**，包含空闲和等待；不是模型瞬时生成速度。
- Claude 通过 `claude:stream` 启动的会话额外提供实时字/秒；已有交互会话与 Antigravity 暂无文字流，显示未连接。新客户端均不提供账户额度；Codex 的既有指标保持原状。
- 指定会话显示保留的本机累计；全局模式只统计保存起点之后报告的用量，切换范围不重设起点。
- 有界读取：最多 500 个会话文件、20,000 个去重消息；Claude 初次读取末尾最多 8 MiB，超过部分、格式错误或读取失败会标为不完整。Antigravity 每库最多 10,000 行、每条 1 MiB、每次最多 32 MiB，预算不足不冒充完整覆盖。
- 暂未在真实安装的 Claude Code / Antigravity 上完成端到端验证。合成记录、真实 SQLite 和 stdio 集成测试验证的是这些已定义格式；Windows CI 已实际启动两个监控，用自有宿主验证数值/未知状态、窗口最小化/恢复和独立单例，并通过原生编译与绘图检查。可见窗口启动测试使用私有源码副本和临时目录，本机默认不运行；如需主动运行，可在 PowerShell 中先设置 `$env:CODEX_PULSE_RUN_NATIVE_STARTUP_TESTS='1'` 再执行 `npm test`。

## 本机诊断

```powershell
npm run diagnose:clients
```

输出系统/Node 版本、会话数量、是否发现兼容用量、覆盖状态和读取错误数量。导出不包含完整路径、聊天 ID、正文、凭据或账户用量数值。如果 Antigravity 显示当前记录格式未支持，保留这个诊断结果即可定位下一步适配，不能用零用量替代。

Claude 生成期间可另开终端执行诊断；`liveTextConnected: true` 与 `streamCoverage: "available"` 表示文字计数流已连接。流尚未结束时，`compatibleUsageFound` 仍可能为 false，表示官方用量尚未进入日志；两者是不同状态。生成结束后连接状态自然回落。计数读取异常看 `streamReadErrors`。
