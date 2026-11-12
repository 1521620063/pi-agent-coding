# Marketplace 发布说明

## 当前发布材料

- 扩展 ID：`SilasPaul.pi-coding-agent`
- 展示名：`PI`
- 版本：`1.0.0`，清单标记为预览版
- 安装包：仓库根目录 `pi-coding-agent-1.0.0.vsix`
- 已有图标、暗色/浅色浏览器夹具截图、更新记录、隐私说明及第三方许可全文。

## 本机验证与打包

```powershell
npm ci
npm run validate
npm run compile
npm run test:vscode
npm run test:webview
npm run package
```

打包钩子会重新执行类型、单元及模拟进程检查。VS Code 和浏览器测试需要本机图形环境。模拟 PI 与浏览器夹具通过不代表真实模型、MCP 或所有操作系统均已验收；实际兼容范围见 README。

## 账号侧待办

本次没有上传、发布或修改 GitHub 远端配置。当前环境未提供可用 GitHub CLI、令牌或浏览器登录会话，不能代为确认账号所有权或修改远端简介。

1. 在 GitHub 仓库 About 中删除“变更审批能力”。建议替换为：

   > 为 PI coding agent 提供 VS Code 侧栏，通过本机 RPC 展示对话、工具执行结果并管理会话。

2. 登录 VS Code Marketplace 的发布者管理页面，确认当前账号有 `SilasPaul` 发布者的管理或发布权限。账号显示名与 publisher ID 不应混淆。
3. 首次上传前确认展示名和扩展名称可用；本地打包检查不能代替商城服务器校验。
4. 审阅 README、截图、隐私说明和安装包后，手动上传仓库根目录的 VSIX。上传行为不包含在本次修复中。

后续修改源码后，需要重新构建及打包；修改版本号时同步 package.json、package-lock.json、README 和安装命令。
