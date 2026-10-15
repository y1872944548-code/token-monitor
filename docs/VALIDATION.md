# 本次验证记录

## 0.9.0 多客户端

新增 Claude Code 本机 JSONL 与 Antigravity 实验性 SQLite 适配，覆盖重复报告、缓存计数、局部/全局范围、设置恢复、未知格式、SQLite 只读和客户端隔离。新增集成测试实际启动当前 MCP 和原生窗口所使用的 Node feed，使用合成文件验证更新、范围切换和父进程关闭后的退出。

Node 回归共 37 项；Linux 上 35 通过、0 失败，Windows 路径与 Windows 启动测试两项按平台跳过；Windows CI 中仅跳过需要 Unix 符号链接的路径检查。Windows 启动测试实际编译测试宿主，调用私有源码副本中的启动脚本，验证 Claude / Antigravity 两个独立监控进程、用量/未知状态、最小化、恢复和重复打开；不会控制真实客户端或触发模型。该可见窗口测试在本机默认跳过，由 CI 显式开启；即使主动在本机开启，也不会复用实际安装的监控可执行文件路径。PowerShell 三个脚本语法检查通过。以上测试不代表真实安装的 Claude Code / Antigravity 端到端验收，具体数据格式边界见 [CLIENTS.md](CLIENTS.md)。

提交 `4b88bcd` 的 [Checks](https://github.com/y1872944548-code/token-/actions/runs/38805595693) 已完成，Linux / Windows 两个作业均成功，包括 Windows 的新增启动链路测试及 `test:native` 原生检查。过程中修复了测试数据库句柄清理顺序，以及原有 Codex 全局增量读取对文件修改时间精度的依赖；后者有固定旧文件时间的回归覆盖。

## 0.8.1 初次源码整理

本次在 Linux 云环境、Node.js 24.19.0 / npm 11.9.0 中检查。原始上传包保留，没有使用其中的 `node_modules` 或 Windows 可执行文件作为验证依据。

| 检查 | 结果与范围 |
| --- | --- |
| 原始测试基线 | 19 项通过 |
| 新增问题复现 | 修改前，文字重放重复计数、未递增版本两个回归测试失败；修复后通过 |
| `npm ci` | 从官方 npm 仓库安装成功，锁文件完整性校验保留；原锁文件有不可满足的 iconv-lite 版本范围，已重新解析 |
| `npm test` | 共 26 项；Linux 上 25 通过、0 失败、1 项 Windows 路径检查明确跳过；含日志增量、全局去重、暂停/恢复、协议、Unicode、速度与范围隔离 |
| 当前浮条 MCP 集成 | 实际启动 `src/float-mcp.mjs`，通过 stdio 读取合成日志，验证指定对话的真实数值 |
| `npm run configure:mcp` | 当前目录生成成功；重复运行结果一致；自动测试覆盖中文/空格目录、保留其他服务、拒绝损坏配置 |
| `npm run check:mcp` | 当前生成配置的工具发现与摘要校验通过；未请求打开原生窗口 |
| PowerShell 语法 | 3 个脚本由 PowerShell 7.5.0 AST 解析通过；工具包用官方 SHA-256 校验，不代表 Windows PowerShell 5.1 执行通过 |
| 源码包复现 | 从排除本机数据的 ZIP 解压到新目录，重新 `npm ci`、运行测试、生成配置并检查 MCP；未使用原目录的 node_modules |

## GitHub Actions 后续验证

源码已推送到 `main`。提交 `58c5035` 的 [Checks #3](https://github.com/y1872944548-code/token-/actions/runs/38796616085) 已完成，Linux 与 Windows 两个作业均成功。Windows 作业包含 Node 测试、当前配置的 MCP 检查，以及 `npm run test:native` 的原生编译和测试窗口检查。

首次 Windows 原生测试失败的原因是测试点击坐标假定按钮始终完整展开；CI 屏幕将按钮收为窄标签后，固定坐标落在了控件外。测试现改为点击当前控件区域，保留点击展开、关闭后重开与拖动不误触等断言；失败详情会输出为 Actions 注释。旧的失败记录保留，以上链接为修复后的成功检查。

真实 Codex 窗口联动与真实 `codex-ipc` 接入仍未在本轮验证。自动检查使用自己的测试窗口与合成事件，不代表用户桌面的端到端验收；仓库自带的历史本机记录也不能代替修改后的真实桌面验证。

已添加 Windows CI 和本机 `npm run setup:windows` / `npm run test:native` 命令。真实交互仍需在 Windows 上检查按钮、范围切换、最小化和速度曲线。未创建 Windows 安装包或 Release。
