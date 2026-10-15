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

## Antigravity（实验性）

按 Google 官方 Windows 客户端 `Antigravity.exe` 识别窗口。读取 `~/.gemini/antigravity/*.db` 与 `conversations/*.db` 中 UUID 命名的会话数据库；`GEMINI_CLI_HOME` 替换 `.gemini` 根目录，或用 `CODEX_PULSE_ANTIGRAVITY_HOME` 直接指定 Antigravity 数据目录。

支持 ordinary `gen_metadata(idx,data)` 表和嵌入式生成时间戳 `chatModel.#9.#4` 的数值记录。仅解码用量字段，不解码聊天正文。SQLite 以只读模式打开，不复制数据库或修改记录；正常 WAL 读取可能使用 SQLite 的共享内存协调机制。

格式依据来自公开的第三方本机格式研究，**不是 Google 的稳定公开接口**：

- [Tokscale 的固定版本解析说明](https://github.com/junhoyeo/tokscale/blob/62ca1eb1677556972ba963fdfa3a41ab23c1eb4b/crates/tokscale-core/src/sessions/antigravity_cli.rs)
- [CodexBar 的本机格式与覆盖边界说明](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md#local-token-history)

其中 usage field 1 为模型枚举，不能算 Token；使用 field 2 的新输入、field 5 的缓存读取和 field 3 的总输出。对 field 9/10 仅校验合计，不猜测哪一项是可见/推理输出。缺少总输出时，两项均存在且有效才能使用其合计。缺少嵌入时间戳、矛盾计数或不认识的布局不会用文件修改时间补齐。

旧版仅提供 `.pb` 的记录、需要其他时间戳恢复方式的数据库以及未来未知格式暂不支持。发现这类记录会显示未支持/未知状态，不能声称已经完成其用量采集。版本号不需要用户预先填写，兼容性按实际文件与字段判断；这不等于支持所有版本。

## 指标与覆盖

- 新客户端的 TPS 为**最近 120 秒报告的输出 Token / 120 秒**，包含空闲和等待；不是模型瞬时生成速度。
- 本轮不提供新客户端的逐字流速或账户额度，这些位置显示“未提供”；Codex 的既有指标保持原状。
- 指定会话显示保留的本机累计；全局模式只统计保存起点之后报告的用量，切换范围不重设起点。
- 有界读取：最多 500 个会话文件、20,000 个去重消息；Claude 初次读取末尾最多 8 MiB，超过部分、格式错误或读取失败会标为不完整。Antigravity 每库最多 10,000 行、每条 1 MiB、每次最多 32 MiB，预算不足不冒充完整覆盖。
- 暂未在真实安装的 Claude Code / Antigravity 上完成端到端验证。合成记录、真实 SQLite 和 stdio 集成测试验证的是这些已定义格式，Windows CI 验证编译与自有测试窗口。

## 本机诊断

```powershell
npm run diagnose:clients
```

输出系统/Node 版本、会话数量、是否发现兼容用量、覆盖状态和读取错误数量。导出不包含完整路径、聊天 ID、正文、凭据或账户用量数值。如果 Antigravity 显示当前记录格式未支持，保留这个诊断结果即可定位下一步适配，不能用零用量替代。
