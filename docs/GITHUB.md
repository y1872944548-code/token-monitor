# 将源码上传到 GitHub

当前交付为源码版。项目尚未选择开源许可证；上传源码并不自动授予他人修改和再分发许可。如果需要开源，请由作者选择许可证后补充 `LICENSE`。第三方组件保留各自许可证。

## 首次上传

在本机准备好的项目目录中运行。若尚无 `.git` 目录，先执行 `git init -b main`；若是从 GitHub 克隆的空仓库，可直接继续：

```powershell
git status --short
git add .
git diff --cached --stat
```

暂存列表应包含源码、README、测试和 `package-lock.json`，不应包含 `node_modules/`、`runtime/`、`QA/`、`记忆日志.md` 或 `.mcp.json`。如果你过去已经提交过这些文件，`.gitignore` 不会移除已有跟踪项，应先单独处理。

确认列表后：

```powershell
git commit -m "Initial Codex Pulse source"
git branch -M main
git remote -v
```

若尚未设置远端，再运行：

```powershell
git remote add origin https://github.com/y1872944548-code/token-.git
```

已有远端时先确认它指向目标仓库，不要重复添加或覆盖其他仓库的地址。随后上传：

```powershell
git push -u origin main
```

首次登录使用 GitHub 正常认证流程，不要把 Token 写进源码或远端 URL。

## 上传后检查

1. 查看仓库 Actions 中的 Checks 工作流结果。Windows 和 Linux 作业应全部完成；工作流文件存在不等于已经运行通过。
2. 在新的 Windows 目录克隆源码，执行 `npm run setup:windows` 和 `npm run start:windows`。
3. 用真实 Codex 验证按钮、拖动、最小化、指定/全局范围与速度切换。自动化的合成事件测试不能替代这个步骤。
4. 再决定是否制作 Windows 发布包、增加截图或创建版本标签；截图应使用演示数据。

不要将本机已有的 `runtime/*.exe` 直接当作本次源码编译的发布产物。当前交付没有生成 Windows 安装包或发布 Release。
