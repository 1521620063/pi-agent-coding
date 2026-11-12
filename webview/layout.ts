export const moreActions = [
  ["renameSession", "重命名会话"],
  ["attachDiagnostics", "选择诊断作为附件"],
  ["touchedFiles", "本次对话修改的文件"],
  ["openScm", "打开源代码管理"],
  ["searchConversation", "搜索 PI 完整历史"],
  ["showCommands", "技能与模板来源"],
  ["cycleModel", "轮换模型"],
  ["cycleThinking", "轮换思考强度"],
  ["openSession", "打开 PI 会话文件"],
  ["fork", "分叉（不回滚文件）"],
  ["clone", "复制（不回滚文件）"],
  ["tree", "浏览历史树"],
  ["export", "导出 HTML"],
  ["compact", "手动压缩"],
  ["settings", "插件设置"],
  ["disconnect", "断开连接"],
] as const;

export const sidebarMarkup = `
<header>
  <strong aria-hidden="true">π</strong><span id="title">PI</span><div class="spacer"></div>
  <wa-button size="s" appearance="plain" variant="neutral" data-action="newSession" aria-label="新建会话" title="新建会话"><wa-icon name="plus"></wa-icon></wa-button>
  <wa-popup id="history-popup" placement="bottom-end" distance="6" flip shift shift-padding="8" auto-size="both" auto-size-padding="8">
    <wa-button slot="anchor" id="sessions" size="s" appearance="plain" variant="neutral" aria-label="历史会话" title="历史会话" aria-haspopup="dialog" aria-expanded="false" aria-controls="history-panel"><wa-icon name="clock"></wa-icon></wa-button>
    <section id="history-panel" role="dialog" aria-label="当前工作区历史" tabindex="-1" hidden>
      <div class="history-heading">工作区历史</div>
      <wa-input id="history-search" size="s" label="筛选会话" placeholder="名称、ID 或路径" clearable></wa-input>
      <div id="history-list"></div>
      <wa-button id="history-open" size="s" appearance="plain" variant="neutral">打开其他 PI 会话文件…</wa-button>
      <p class="muted history-hint">移除记录会保留 PI 会话文件</p>
    </section>
  </wa-popup>
  <div id="settings-popup">
    <wa-button id="settings-toggle" size="s" appearance="plain" variant="neutral" aria-label="设置" aria-haspopup="dialog" aria-expanded="false" aria-controls="settings-panel" title="设置：上下文与重试"><wa-icon name="gear"></wa-icon></wa-button>
    <section id="settings-panel" role="dialog" aria-label="PI 设置" tabindex="-1" hidden>
      <div class="settings-heading"><strong>上下文与重试</strong><wa-button id="settings-close" size="s" appearance="plain" variant="neutral" aria-label="关闭设置" title="关闭设置"><wa-icon name="xmark"></wa-icon></wa-button></div>
    <div class="settings-fields">
      <wa-switch id="auto-compaction" size="s" hint="由 PI 在需要时整理会话上下文">自动压缩</wa-switch>
      <wa-switch id="auto-retry" size="s" hint="使用 PI 自身的自动重试设置">自动重试<span id="retry-known"></span></wa-switch>
      <wa-select id="steering-mode" size="s" label="补充指示处理方式" value=""><wa-option value="">PI 设置未知</wa-option><wa-option value="one-at-a-time">逐条处理</wa-option><wa-option value="all">一次处理全部</wa-option></wa-select>
      <wa-select id="followUp-mode" size="s" label="后续消息处理方式" value=""><wa-option value="">PI 设置未知</wa-option><wa-option value="one-at-a-time">逐条处理</wa-option><wa-option value="all">一次处理全部</wa-option></wa-select>
      <div class="settings-action"><span class="muted">立即整理当前会话</span><wa-button data-action="compact" size="s" appearance="outlined" variant="neutral">手动压缩</wa-button></div>
    </div>
      <wa-button data-action="settings" size="s" appearance="plain" variant="neutral">打开 VS Code 插件设置…</wa-button>
    </section>
  </div>
  <wa-dropdown id="actions" size="s" placement="bottom-end">
    <wa-button slot="trigger" size="s" appearance="plain" variant="neutral" aria-label="更多操作" title="更多操作"><wa-icon name="ellipsis"></wa-icon></wa-button>
    ${moreActions.map(([value, label]) => `<wa-dropdown-item value="${value}">${label}</wa-dropdown-item>`).join("")}
  </wa-dropdown>
</header>
<div id="error" role="alert" hidden></div><div id="connection" hidden></div>
<details class="conversation-search"><summary>搜索对话</summary><wa-input id="conversation-search" size="s" label="搜索当前可见对话" clearable></wa-input><wa-button data-action="searchConversation" size="s" appearance="plain">搜索 PI 完整历史…</wa-button></details>
<main id="transcript" aria-label="PI 对话" tabindex="0"></main>
<section id="activity" aria-live="polite"></section><div id="widgets-above"></div><section id="queue" hidden></section>
<footer>
  <div id="run-controls" hidden><span class="muted">当前任务</span><wa-button data-action="stop" id="stop" size="s" appearance="outlined" variant="danger">停止全部</wa-button></div>
  <div class="composer">
    <div id="attachments"></div><div id="command-menu" role="listbox" aria-label="输入补全" hidden></div>
    <wa-textarea id="prompt" rows="3" resize="auto" size="s" aria-label="发送给 PI" aria-controls="command-menu" aria-expanded="false" placeholder="有什么想一起完成的？@ 添加文件，/ 选择命令"></wa-textarea>
    <div class="input-actions">
      <div class="attach-actions">
        <wa-button id="attach-files" size="s" appearance="plain" variant="neutral" data-action="attachFiles" aria-label="添加文件或图片" title="添加文件或图片"><wa-icon name="plus"></wa-icon></wa-button>
    <div class="composer-meta">
      <wa-dropdown id="model-menu" size="s" placement="top-start">
        <wa-button slot="trigger" id="model" size="s" appearance="plain" variant="neutral" title="切换 PI 模型"><span id="model-name">选择模型</span><wa-icon slot="end" name="chevron-down"></wa-icon></wa-button>
      </wa-dropdown>
      <wa-dropdown id="thinking-menu" size="s" placement="top-end">
        <wa-button slot="trigger" id="thinking" size="s" appearance="plain" variant="neutral" title="调整思考强度"><span id="thinking-name">思考</span><wa-icon slot="end" name="chevron-down"></wa-icon></wa-button>
      </wa-dropdown>
    </div>
      </div>
      <div class="send-actions">
        <wa-select id="mode" value="followUp" size="s" appearance="outlined" aria-label="运行时发送方式" placement="top"><wa-option value="followUp">后续消息</wa-option><wa-option value="steer">补充指示</wa-option></wa-select>
        <wa-button id="send" size="s" variant="brand" appearance="accent" aria-label="发送消息" title="发送消息 · Enter" disabled><wa-icon name="arrow-up"></wa-icon></wa-button>
      </div>
    </div>
  </div>
  <div class="statusline composer-hint"><span>Enter 发送 · Shift+Enter 换行</span><span id="usage"></span></div>
  <div class="statusline" id="statuses" hidden></div>

</footer>
<div id="widgets-below"></div>
<details id="shell-panel"><summary>PI 命令</summary>
  <div class="shell-fields">
    <wa-input id="shell-command" size="s" label="命令" placeholder="输入要执行的命令" hint="由 PI 执行，输出默认加入下一次请求的上下文。" spellcheck="false" autocomplete="off"></wa-input>
    <wa-switch id="shell-exclude" size="s" hint="本次输出仅用于查看">不加入上下文</wa-switch>
    <div class="shell-actions"><wa-button id="run-shell" size="s" appearance="outlined" variant="brand" disabled>运行命令</wa-button><wa-button data-action="cancelShell" id="cancel-shell" size="s" appearance="plain" variant="danger" hidden>取消命令</wa-button></div>
    <pre id="shell-output" aria-live="polite"></pre>
  </div>
</details>`;
