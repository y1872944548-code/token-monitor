# 本次验证记录

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

Windows 原生编译、真实 Codex 窗口交互、真实 `codex-ipc` 接入以及 GitHub Actions 云端作业尚未在本轮运行。仓库自带的历史本机验证记录不能代替修改后的 Windows 验收。

已添加 Windows CI 和本机 `npm run setup:windows` / `npm run test:native` 命令。真实交互仍需在 Windows 上检查按钮、范围切换、最小化和速度曲线。未创建 Windows 安装包或 Release。
