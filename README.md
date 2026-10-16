# Codex Pulse · Codex 运行监控

Windows 原生悬浮监控工具，查看本机 Codex 对话的已上报 Token、输出速度和账户额度。新增 Claude Code 本机日志适配与 Antigravity 实验性 SQLite 用量适配。支持指定对话 / 本机全局范围、滚动曲线、窗口边缘按钮、位置记忆与 60%–200% 缩放。

Claude Code 日志监控使用 `npm run start:claude`，Antigravity 使用 `npm run start:antigravity`；首次仍先执行下面的安装命令。Claude 新增流式启动入口，可显示生成中的实时字/秒：

```powershell
npm run claude:stream -- --cwd "C:\你的项目" "介绍这个项目的结构"
```

这会调用已安装、已登录的 Claude CLI，以非交互 print 模式执行一次请求，并在 Windows 自动打开该会话的浮条；它不是接管已有交互终端。0.11.0 新增“官方流 TPS”：直接读取官方累计 `output_tokens`，用相邻计数增量和本机接收间隔计算。上游只有结束上报时显示“本次响应均速”，生成中尚无 Token 报告时显示等待；没有将字数换算成 Token。

当前验证的 Anthropic 官方普通流示例只有结束用量，因此不能保证逐 Token 的实时分辨率。实时字/秒继续独立提供。新客户端的可用指标、继续会话、Windows 窗口识别和边界见[多客户端说明](docs/CLIENTS.md)。

它通过本机日志和桌面事件读取统计数据，不修改 Codex 客户端。实时采集不需要模型轮询。项目由独立开发者维护，内部桌面事件接口可能随 Codex 升级而变化。

## 安装运行

要求 Windows 10/11 64 位、Node.js 24 LTS（含 npm）、系统自带的 Windows PowerShell 和 .NET Framework 4.x，以及已安装的 Codex 桌面应用。首次安装需要访问 npm 包仓库，不需要 API Key。

在项目文件夹中打开 PowerShell：

```powershell
npm run setup:windows
npm run start:windows
```

`setup:windows` 使用锁文件安装依赖，生成当前电脑的 `.mcp.json`，运行 Node 测试和原生窗口测试；启动命令会编译悬浮窗。路径可以包含空格和中文，无需编辑源码或手动填写聊天 ID。建议先启动 Codex 并创建一个本机对话；聊天索引尚未建立时会显示等待状态。

默认首次启动采用本机全局范围，从首次启动的统计起点开始计数；之后保留你的范围、位置和尺寸。通过设置面板可以选择指定对话，或重新开始本次全局统计。

仅准备边缘按钮、不立即展开浮条：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-float.ps1 -ButtonOnly
```

需要登录后自动伴随时，由你主动运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-float.ps1 -EnableCompanion -ButtonOnly
```

此选项只设置当前用户 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `CodexPulseCompanion` 值。可在浮条设置中关闭登录启动；删除项目之前请先关闭它。默认安装不会开启登录启动。

## 使用

- 边缘“监控”按钮可以展开或收起浮条；窗口外侧空间不足时，移入窄标签即可展开按钮。
- 拖动调整位置，右下角缩放；设置中可切换范围、速度单位和动态背景。
- `Ⅱ` 暂停显示，`×` 收起浮条，设置中可以完整退出。
- Codex 最小化时隐藏浮条并继续采集，完全退出时暂停采集。浮条处于普通窗口层，其他应用可以覆盖它。

## 速度和 Token 的含义

| 指标 | 计算方式 | 使用边界 |
| --- | --- | --- |
| 已上报 Token | 官方报告的累计用量；全局按请求明细与 response ID 去重 | 缓存和推理子集不重复相加；不推测未上报用量 |
| 输出 TPS · 上报均速 | 单对话：相邻输出 Token 增量 / 报告间隔；全局：统计起点后最多 120 秒窗口内的输出 Token / 窗口秒数 | 可能包含报告中的推理 Token、等待或工具时间，不是瞬时生成速度或纯模型性能基准 |
| 实时可见文字 | 最近 2 秒内收到的新增可见 Unicode 字符数 / 2 | 单位为字/s，不是 Token/s；不包含隐藏推理和工具输出 |
| 账户额度 | 本机最新的账户共享额度观测 | 可能延迟，不等于当前对话费用，不跨对话相加 |

15 秒没有新的官方用量报告时，界面显示待上报。桌面事件不可用时回退日志，并显示来源/覆盖限制。全局只覆盖当前电脑可读取、可连接的对话，不代表其他设备或云端完整用量。若只有旧版累计日志而没有逐请求明细，不会将其冒充全局请求总量。

## 在 Codex 中使用工具

安装命令会生成与当前目录和 Node 路径匹配的 `.mcp.json`；文件包含本机路径，已被 Git 忽略。把项目移动到其他目录后运行 `npm run configure:mcp` 重新生成，再刷新宿主中的插件配置。

`.codex-plugin/plugin.json` 提供插件元数据与技能入口。按宿主支持的本地插件安装流程加载当前目录即可；仅添加插件元数据不会自动安装依赖或开启 Windows 登录启动。

- `pulse_open`：打开原生浮条，沿用保存的设置。
- `pulse_snapshot`：读取一次摘要，可通过 `threadId` 明确指定对话。

不要让模型循环调用工具刷新数据。正常浮条刷新由本机采集器负责。

```powershell
npm run configure:mcp
npm run check:mcp
# Windows 上实际启动浮条并检查摘要（需要本机 Codex）
npm run check:mcp -- --open
```

## 开发与验证

核心统计、日志读取和 MCP 协议支持在 Linux、macOS 和 Windows 上开发与测试；原生浮条和真实命名管道集成需要 Windows。

```sh
npm ci
npm test
npm run configure:mcp
npm run check:mcp
```

Windows 原生检查：

```powershell
npm run test:native
```

原生检查编译源码并使用自己的测试窗口验证层级、按钮、缩放、UTF-8 与绘图，不会启动模型或修改登录启动。输出位于 `runtime/native-layout-tests/`。GitHub Actions 配置包含 Linux / Windows Node 测试，以及 Windows 原生检查；以实际运行结果为准。

旧版网页诊断入口为 `npm run diagnostic:web`，仅用于开发排查，不是原生浮条。它只绑定本机回环地址。

## 数据与目录

```text
src/                  统计、只读事件适配器、MCP 与日志读取
native/               Windows WinForms 浮条与原生测试
scripts/              配置、启动、安装及验证命令
test/                 自动化测试与合成数据
public/               历史网页/内嵌组件诊断资源
skills/               Codex 插件技能说明
runtime/              本机设置、聚合状态和生成文件（不提交）
```

默认从用户目录下 `.codex` 读取会话数据；使用自定义 Codex 目录时需让启动进程继承 `CODEX_HOME`。`CODEX_PULSE_DATA_DIR` 可以调整当前进程的数据目录，`CODEX_PULSE_SETTINGS_FILE` 可以覆盖设置文件。自定义目录用于测试或手动启动；当前登录伴随命令不会替你持久化这些环境变量。

可见文字仅在内存中转成字符计数；统计代码不保存正文，不发起模型生成请求。运行状态可能包含聊天标题、ID、额度与本机路径，因此不要提交 `runtime/`、个人 QA 截图或日志。上传的历史资料保留在本地并被 Git 忽略；发布包只包含源码与合成测试数据。

`native/PortableLauncher.cs` 为便携启动器原型，当前源码版不提供 `Install.cmd` 或预编译的一键安装包。请使用以上已定义的源码安装流程。

## 上传 GitHub 与故障排查

见 [GitHub 上传指南](docs/GITHUB.md)、[本次验证记录](docs/VALIDATION.md)和[历史安装问题](docs/KNOWN-ISSUES.md)。

若 npm 安装失败，先确认 Node 24 和 npm 仓库连通性；使用 `npm ci`，不要跳过完整性或 TLS 校验。若浮条没有显示，先确认 Codex 已打开且未最小化，再检查本机 `runtime/float-error.log`；桌面升级造成的内部协议不兼容，应以日志回退和明确错误处理，不能用估算数据代替。
