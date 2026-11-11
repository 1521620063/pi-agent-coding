# PI-Extension

通过本机已安装的 PI coding agent，为 VS Code 提供侧边栏聊天、工具执行展示、编辑结果差异与会话操作。插件负责 UI 桥接，智能体、模型和工具仍由 PI 执行。

交互组织参考 Codex / Claude Code 的侧栏使用方式，界面样式优先参考 PI 自身的简洁布局、消息和工具配色，并适配 VS Code 主题。

已实现首个本地版本 `0.1.0`，验证基线为 Windows、PI 1.5.2。插件通过 `pi --mode rpc` 启动并管理独立的 PI 进程，不会接管已有终端中的 PI 进程。

## 安装与开始使用

1. 在本机安装并配置 PI，确认已有可用模型；插件沿用 PI 自身的配置和登录状态。
2. 在 VS Code 中运行 **Extensions: Install from VSIX…**，选择 `pi-sidebar-0.1.0.vsix`。
3. 打开并信任本地文件夹，点击活动栏的 **π / PI**，再点击 **连接 PI**。多根工作区会提示选择本次 PI 的工作目录。
4. 输入问题，按 Enter 发送；Shift+Enter 换行，中文输入法选字时 Enter 不会发送。

如果无法自动找到 PI，在 VS Code 设置中配置 **PI: Executable Path**（`pi.executablePath`），支持可执行文件、官方 `.ps1` / npm `.cmd` 启动器及 JS 入口；必要时配置 **PI: Node Path**（`pi.nodePath`）。路径设置为机器级，不从仓库配置中接受任意启动器路径。启动诊断显示在侧栏和 **输出 → PI**。

## 已有功能

- 流式 Markdown、可折叠思考与工具结果、真实 edit 工具返回的修改差异、图片结果及错误状态。
- 附加当前选区（包括未保存内容）、UTF-8 文本文件和图片；支持粘贴、拖入图片，模型不支持图片时会提示。
- 发现并切换 PI 模型和思考强度；输入 `/` 选择 PI 发现的技能、模板或扩展命令，具体解释和执行由 PI 完成。
- 运行中发送补充指示或后续消息、查看队列、清空队列并恢复到输入框；停止时先清空队列，再中止当前运行。
- 新建、打开、重命名会话，恢复当前工作区曾通过插件打开的会话；浏览只读历史树、分叉、复制和导出 HTML。
- 用量、费用、上下文占用、自动重试状态、重试取消、自动及手动压缩的 RPC 桥接。
- PI 扩展的选择、确认、输入和编辑对话框，以及文本状态、标题、widget 和编辑器内容更新；PI shell 命令与取消。

侧栏隐藏后 PI 会继续工作；通过菜单断开或关闭扩展会清理插件创建的 PI 进程。异常断开后需主动重连，插件不会自动重放消息。

## 范围与限制

仅验证本地 Windows 扩展宿主；远程、虚拟及未受信任工作区不启动 PI。macOS / Linux 尚未实测。PI 1.5.2 是验证基线，其他版本是否兼容取决于其 RPC 能力。

会话历史列表是插件自己的工作区索引，不扫描 PI 的全局会话库；可以手动打开其他 PI `.jsonl` 会话。分叉和复制只改变对话，不回滚文件。修改差异是 PI 执行后的结果展示。

插件继承 PI 加载的工具和 MCP，并通用展示结果；真实 MCP 环境以及长会话成功压缩尚未验收。终端专用交互、自定义终端 UI、交互登录和终端主题同步不在首版范围内，需在 PI 自身完成。界面使用 PI 的视觉层次并适配 VS Code 主题。

插件附件限制：每个文件/图片 5 MiB，图片合计 15 MiB，最多 100 个附件。工具文本预览最多 30,000 字符，独立命令输出最多 200,000 字符；截断会标注。

## 本地开发

```powershell
npm ci
npm run check
npm test
npm run test:integration
npm run compile
npm run test:vscode
npm run package
```

打开本目录后按 F5 运行扩展开发宿主。`test:vscode` 优先使用本机 VS Code，可用 `PI_TEST_VSCODE` 指定可执行文件；它使用隔离的测试配置、扩展目录和临时工作区。构建将 Markdown 渲染依赖打入 Webview，VSIX 不包含 PI 运行库。

- [验证记录](docs/testing.md)：区分模拟、VS Code 宿主、真实 PI / 模型和浏览器视觉检查，列出尚未验证的场景。

- [开发计划](docs/superpowers/plans/2026-11-11-pi-vscode-bridge-plan.md)：按 P0/P1/P2 排序的任务、文件、接口和验收条件。
- [设计说明](docs/superpowers/specs/2026-11-11-pi-vscode-bridge-design.md)：功能范围、PI 能力映射与不支持的边界。
