import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Real Web Awesome controls in a browser fixture; this is not a VS Code screenshot.
const artifacts = await mkdtemp(join(tmpdir(), "pi-webview-"));
const fixture = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
  import { SessionStore } from './src/state/session-store';
  const store = new SessionStore();
  store.update({connection:'connected',workspace:'C:/workspace',session:{id:'fixture'},
    model:{id:'test',provider:'fixture',input:['text']},models:[{id:'test',provider:'fixture',input:['text']}],
    thinkingLevel:'medium',thinkingLevels:['off','medium'],queueModes:{steering:'one-at-a-time',followUp:'all'},
    commands:[{name:'alpha',source:'skill'},{name:'beta',source:'prompt'}],
    sessions:[{sessionId:'one',sessionPath:'one.jsonl',lastOpenedAt:'2026-11-12'},{sessionId:'two',sessionPath:'two.jsonl',lastOpenedAt:'2026-11-12'}]});
  store.replaceMessages([{role:'user',content:'你好'},{role:'assistant',content:'示例代码\\n\\n\u0060\u0060\u0060ts\\nconst answer = 42;\\n\u0060\u0060\u0060\\n[source](main.ts:2)'}]);
  window.actions=[]; window.fixtureState=store.getSnapshot();
  window.deliver=(data)=>window.dispatchEvent(new MessageEvent('message',{data}));
  window.acquireVsCodeApi=()=>({getState:()=>({draft:'保留草稿'}),setState:(s)=>window.saved=s,postMessage:(action)=>{
    window.actions.push(action);
    if(action.type==='ready') queueMicrotask(()=>window.deliver({type:'snapshot',state:window.fixtureState}));
    if(action.type==='searchFiles') queueMicrotask(()=>window.deliver({type:'fileCandidates',requestId:action.requestId,items:[{id:'one',label:'main.ts',source:'workspace'},{id:'two',label:'中文.ts',source:'open'}],truncated:false}));
  }});
  await import('./webview/main');
`,
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome130",
  write: false,
  outfile: "fixture.js",
  loader: { ".css": "empty" },
});
const fixtureJs = fixture.outputFiles.find((file) =>
  file.path.endsWith(".js"),
).text;
const server = createServer(async (request, response) => {
  const name = request.url?.slice(1);
  try {
    if (!name) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>PI Webview Test</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'nonce-fixture';"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/webview.css"></head><body><div id="app"></div><script nonce="fixture" type="module" src="/fixture.js"></script></body></html>`,
      );
    } else if (name === "fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(fixtureJs);
    } else if (["theme.css", "styles.css", "webview.css"].includes(name)) {
      response.setHeader("Content-Type", "text/css");
      response.end(await readFile(join("dist", name)));
    } else if (name === "favicon.ico") {
      response.statusCode = 204;
      response.end();
    } else {
      response.statusCode = 404;
      response.end();
    }
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
// Windows may allocate a port Chromium blocks (for example 6665) for port 0.
for (let attempt = 0; attempt < 20 && !server.listening; attempt++) {
  try {
    await new Promise((done, reject) => {
      const failed = (error) => reject(error);
      server.once("error", failed);
      server.listen(
        49152 + Math.floor(Math.random() * 12000),
        "127.0.0.1",
        () => {
          server.off("error", failed);
          done();
        },
      );
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
  }
}
assert.ok(server.listening, "Unable to allocate a safe browser fixture port");
const address = `http://127.0.0.1:${server.address().port}`;
const candidates = [
  process.env.PI_TEST_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
const browser = await chromium.launch({ executablePath, headless: true });
const failures = [];
const page = await browser.newPage({ viewport: { width: 480, height: 1000 } });
page.on("pageerror", (error) => failures.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") failures.push(message.text());
});
page.on("request", (request) => {
  if (!request.url().startsWith(address) && !request.url().startsWith("data:"))
    failures.push(`External request: ${request.url()}`);
});
const themes = {
  dark: {
    bg: "#181818",
    fg: "#cccccc",
    muted: "#a0a0a0",
    border: "#444444",
    focus: "#007fd4",
    accent: "#4daafc",
  },
  light: {
    bg: "#f8f8f8",
    fg: "#333333",
    muted: "#616161",
    border: "#cccccc",
    focus: "#005fb8",
    accent: "#005fb8",
  },
  contrast: {
    bg: "#000000",
    fg: "#ffffff",
    muted: "#ffffff",
    border: "#ffffff",
    focus: "#ffff00",
    accent: "#00ffff",
  },
};
try {
  await page.goto(address);
  assert.equal(page.url(), `${address}/`);
  assert.equal(await page.title(), "PI Webview Test");
  await page.locator("#model-name").filter({ hasText: "test" }).waitFor();
  const prompt = page.locator("#prompt textarea");
  assert.equal(await prompt.inputValue(), "保留草稿");
  // A closed connection must release local send state without discarding the draft.
  await prompt.fill("断开后保留的草稿");
  await prompt.press("Enter");
  assert.equal(
    await page.locator("#send").evaluate((node) => node.disabled),
    true,
  );
  await page.evaluate(() => {
    window.deliver({
      type: "snapshot",
      state: { ...window.fixtureState, connection: "disconnected" },
    });
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  assert.equal(await prompt.inputValue(), "断开后保留的草稿");
  assert.equal(
    await page.locator("#send").evaluate((node) => node.disabled),
    false,
  );
  await prompt.press("Enter");
  assert.equal(await page.evaluate(() => window.actions.at(-1).type), "send");
  await page.evaluate(() =>
    window.deliver({ type: "sent", attachmentIds: [] }),
  );
  await prompt.fill("保留草稿");
  // Usage is a keyboard-accessible shortcut to the existing host compact flow.
  const usage = page.locator("#usage");
  await usage.click();
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "compact",
  });
  await usage.focus();
  for (const key of ["Enter", "Space"]) {
    const count = await page.evaluate(() => window.actions.length);
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => window.actions.length), count + 1);
    assert.equal(
      await page.evaluate(() => window.actions.at(-1).type),
      "compact",
    );
  }
  await page.evaluate(() =>
    window.deliver({
      type: "snapshot",
      state: { ...window.fixtureState, compaction: { active: true } },
    }),
  );
  assert.equal(await usage.isDisabled(), true);
  assert.match(await usage.textContent(), /正在压缩/);
  assert.equal(await usage.getAttribute("aria-busy"), "true");
  await page.evaluate(() =>
    window.deliver({
      type: "snapshot",
      state: {
        ...window.fixtureState,
        compaction: { active: false, error: "session too small" },
      },
    }),
  );
  assert.equal(await usage.isEnabled(), true);
  assert.match(
    await page.locator("#activity").textContent(),
    /session too small/,
  );
  await page.evaluate(() =>
    window.deliver({
      type: "snapshot",
      state: {
        ...window.fixtureState,
        compaction: {
          active: false,
          notice: "当前会话内容较少，PI 暂无可压缩的上下文，可继续对话。",
        },
      },
    }),
  );
  assert.match(
    await page.locator("#activity [role=status]").textContent(),
    /暂无可压缩/,
  );
  assert.equal(await page.locator("#activity .error").count(), 0);
  assert.equal(await page.locator("#error").isVisible(), false);
  assert.equal(await usage.isEnabled(), true);
  await page.screenshot({
    path: join(artifacts, "compact-not-needed.png"),
    fullPage: true,
  });
  await page.evaluate(() =>
    window.deliver({ type: "snapshot", state: window.fixtureState }),
  );
  // Bash failures must leave chat usable and explain the command/process distinction.
  await page.locator("#shell-panel summary").click();
  const shellInput = page.locator("#shell-command input");
  await shellInput.fill("你好");
  await page.locator("#run-shell").click();
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "shell",
    command: "你好",
    excludeFromContext: false,
  });
  await page.evaluate(() =>
    window.deliver({
      type: "snapshot",
      state: { ...window.fixtureState, shell: { active: true, output: "" } },
    }),
  );
  assert.equal(
    await page.locator("#run-shell").evaluate((node) => node.disabled),
    true,
  );
  assert.equal(await page.locator("#cancel-shell").isVisible(), true);
  await page.evaluate(() => {
    window.fixtureState = {
      ...window.fixtureState,
      shell: {
        active: false,
        output: "/usr/bin/bash: line 1: 你好: command not found",
        exitCode: 127,
      },
    };
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  assert.match(
    await page.locator("#shell-output").textContent(),
    /命令退出码：127/,
  );
  assert.match(
    await page.locator("#shell-output").textContent(),
    /未找到 Bash 命令.*上方聊天输入框/,
  );
  assert.equal(await page.locator("#connection").isVisible(), false);
  assert.equal(
    await page.locator("#run-shell").evaluate((node) => node.disabled),
    false,
  );
  await prompt.fill("你好");
  await prompt.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "send",
    text: "你好",
    attachmentIds: [],
    mode: "followUp",
  });
  await page.evaluate(() => window.deliver({ type: "sent" }));
  await shellInput.fill("echo PI");
  await page.locator("#run-shell").click();
  assert.equal(
    await page.evaluate(() => window.actions.at(-1).command),
    "echo PI",
  );
  await page.evaluate(() =>
    window.deliver({
      type: "snapshot",
      state: {
        ...window.fixtureState,
        shell: { active: false, output: "PI", exitCode: 0 },
      },
    }),
  );
  assert.equal(
    await page.locator("#shell-output").textContent(),
    "PI\n命令退出码：0",
  );
  await page.evaluate(() =>
    window.deliver({ type: "snapshot", state: window.fixtureState }),
  );
  await page.locator("#shell-panel summary").click();
  await prompt.fill("保留草稿");
  // Forking the first prompt leaves an empty branch but must keep the editor usable.
  await page.locator('[data-message-index="0"]').click();
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "forkMessage",
    index: 0,
  });
  await page.evaluate(() => {
    window.beforeFork = window.fixtureState;
    window.fixtureState = {
      ...window.fixtureState,
      messages: [],
      tools: [],
      editorText: { text: "你好", revision: 1, focus: true },
    };
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  assert.equal(await prompt.inputValue(), "你好");
  assert.equal(await page.locator(".assistant-message").count(), 0);
  const editorBounds = await prompt.boundingBox();
  assert.ok(
    editorBounds &&
      editorBounds.y >= 0 &&
      editorBounds.y + editorBounds.height <= 1000,
    `Fork editor outside viewport: ${JSON.stringify(editorBounds)}`,
  );
  assert.equal(
    await prompt.evaluate((node) => node === node.getRootNode().activeElement),
    true,
    "Fork must focus the restored prompt",
  );
  await page.screenshot({
    path: join(artifacts, "fork-editor.png"),
    fullPage: true,
  });
  await prompt.fill("修改后的问题");
  await page.locator(".conversation-search > summary").click();
  await page.locator("#conversation-search input").focus();
  await page.evaluate(() =>
    window.deliver({ type: "snapshot", state: window.fixtureState }),
  );
  assert.equal(
    await prompt.inputValue(),
    "修改后的问题",
    "Repeated snapshots must not overwrite the edited fork draft",
  );
  assert.equal(
    await page
      .locator("#conversation-search input")
      .evaluate((node) => node === node.getRootNode().activeElement),
    true,
    "An applied editor revision must not steal focus again",
  );
  await page.locator(".conversation-search > summary").click();
  await page.evaluate(() => {
    window.fixtureState = window.beforeFork;
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  await prompt.fill("保留草稿");
  assert.equal(
    await page.locator("#mode").count(),
    0,
    "Sending no longer requires a mode selector",
  );
  assert.equal(
    await page.locator('[data-action="attachSelection"]').count(),
    0,
  );
  assert.equal(await page.locator("#settings-panel").isVisible(), false);
  await page.locator("#settings-toggle").click();
  await page.locator("#settings-panel").waitFor();
  assert.equal(
    await page.locator("#queue-settings").evaluate((node) => node.open),
    false,
  );
  assert.equal(await page.locator("#followUp-mode").isVisible(), false);
  await page.locator("#auto-retry [part=control]").click();
  await page.waitForFunction(() => window.actions.at(-1)?.type === "autoRetry");
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "autoRetry",
    enabled: true,
  });
  await page.locator("#queue-settings > summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#followUp-mode").isVisible(), true);
  await page.locator("#followUp-mode").click();
  await page.locator('#followUp-mode wa-option[value="one-at-a-time"]').click();
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "queueMode",
    channel: "followUp",
    mode: "one-at-a-time",
  });
  await page.locator("#steering-mode").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#settings-panel").isVisible(), true);
  await page.locator("#steering-mode").click();
  await page.locator('#steering-mode wa-option[value="all"]').click();
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "queueMode",
    channel: "steering",
    mode: "all",
  });
  await page.locator("#queue-settings > summary").focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#steering-mode").isVisible(), false);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#settings-panel").isVisible(), false);
  assert.equal(
    await page
      .locator("#settings-toggle")
      .evaluate((node) => node.matches(":focus-within")),
    true,
  );
  assert.equal(await prompt.inputValue(), "保留草稿");
  await page.locator("#settings-toggle").click();
  await page.locator("#settings-close").click();
  assert.equal(await page.locator("#settings-panel").isVisible(), false);
  await page.locator("#settings-toggle").click();
  await prompt.click();
  assert.equal(await page.locator("#settings-panel").isVisible(), false);
  await prompt.fill("@");
  await page.locator("#command-menu [role=option]").first().waitFor();
  await prompt.press("ArrowDown");
  await prompt.press("Enter");
  assert.equal(await page.evaluate(() => window.actions.at(-1).id), "two");
  assert.equal(await prompt.inputValue(), "@");
  await page.evaluate(() =>
    window.deliver({ type: "contextAttached", id: "two", success: true }),
  );
  assert.equal(await prompt.inputValue(), "");
  assert.equal(await page.locator("#command-menu").isVisible(), false);
  await prompt.fill("/");
  await prompt.press("ArrowDown");
  await prompt.press("Tab");
  assert.equal(await prompt.inputValue(), "/compact ");
  await prompt.fill("/");
  for (const name of [
    "new",
    "compact",
    "model",
    "thinking",
    "resume",
    "name",
    "fork",
    "clone",
    "tree",
    "export",
    "settings",
    "stop",
  ])
    assert.equal(
      await page
        .locator("#command-menu [role=option]")
        .filter({ hasText: `/${name} ·` })
        .count(),
      1,
    );
  await prompt.fill("/comp");
  await prompt.press("Tab");
  assert.equal(await prompt.inputValue(), "/compact ");
  await prompt.fill("/compact 保留文件名");
  await prompt.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "send",
    text: "/compact 保留文件名",
    attachmentIds: [],
    mode: "followUp",
  });
  await page.evaluate(() =>
    window.deliver({ type: "sent", attachmentIds: [] }),
  );
  assert.equal(await prompt.inputValue(), "");
  for (const [command, control, selector] of [
    ["model", "model", "#model-menu"],
    ["thinking", "thinking", "#thinking-menu"],
    ["resume", "history", "#history-panel"],
    ["settings", "settings", "#settings-panel"],
  ]) {
    await prompt.fill(`/${command} `);
    await prompt.press("Enter");
    if (control === "model" || control === "thinking")
      await page.evaluate((selector) => {
        window.menuShown = new Promise((resolve) =>
          document
            .querySelector(selector)
            .addEventListener("wa-after-show", resolve, { once: true }),
        );
      }, selector);
    await page.evaluate((control) => {
      window.deliver({ type: "sent", attachmentIds: [] });
      window.deliver({ type: "showControl", control });
    }, control);
    if (control === "model" || control === "thinking")
      await page.evaluate(() => window.menuShown);
    else await page.locator(selector).waitFor({ state: "visible" });
    if (control === "settings") await page.locator("#settings-close").click();
    else if (control === "history")
      await page.locator(selector).press("Escape");
    else {
      await page.evaluate((selector) => {
        window.menuHidden = new Promise((resolve) =>
          document
            .querySelector(selector)
            .addEventListener("wa-after-hide", resolve, { once: true }),
        );
      }, selector);
      await page.locator(`${selector} [slot=trigger]`).click();
      await page.evaluate(() => window.menuHidden);
    }
  }
  await prompt.fill("/fork ");
  await prompt.press("Enter");
  await page.evaluate(() =>
    window.deliver({ type: "sent", attachmentIds: [], preserveDraft: true }),
  );
  assert.equal(await prompt.inputValue(), "/fork ");
  await prompt.fill("/compact 保留重点");
  await prompt.press("Enter");
  await page.evaluate(() =>
    window.deliver({
      type: "snapshot",
      state: {
        ...window.fixtureState,
        compaction: { active: true },
        queueControl: { revision: 3, busy: true, canSteer: false },
      },
    }),
  );
  await prompt.fill("/st");
  await prompt.press("Tab");
  assert.equal(await page.locator("#send").isEnabled(), true);
  await page.locator("#send").click();
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "send",
    text: "/stop ",
    attachmentIds: [],
    mode: "followUp",
  });
  await page.evaluate(() =>
    window.deliver({ type: "commandCompleted", text: "/stop " }),
  );
  await prompt.fill("停止后的新草稿");
  await page.evaluate(() => {
    window.deliver({ type: "sent", attachmentIds: [] });
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  assert.equal(await prompt.inputValue(), "停止后的新草稿");
  await prompt.fill("输入法");
  const count = await page.evaluate(
    () => window.actions.filter((a) => a.type === "send").length,
  );
  await prompt.dispatchEvent("compositionstart");
  await prompt.press("Enter");
  await prompt.dispatchEvent("compositionend");
  await prompt.press("Shift+Enter");
  assert.equal(
    await page.evaluate(
      () => window.actions.filter((a) => a.type === "send").length,
    ),
    count,
  );
  await prompt.fill("已提交");
  await prompt.press("Enter");
  await prompt.fill("新草稿");
  await page.evaluate(() =>
    window.deliver({ type: "sent", attachmentIds: [] }),
  );
  assert.equal(await prompt.inputValue(), "新草稿");
  await page.evaluate(() => {
    window.fixtureState = {
      ...window.fixtureState,
      run: "running",
      queues: {
        steering: ["已有补充"],
        followUp: ["先检查协议", "完成后更新说明"],
      },
      queueControl: { revision: 7, busy: false, canSteer: true },
    };
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  assert.equal(await page.locator("#queue [data-steer-index]").count(), 2);
  await prompt.fill("运行中发送");
  await prompt.press("Enter");
  assert.equal(
    await page.evaluate(() => window.actions.at(-1).mode),
    "followUp",
  );
  await page.evaluate(() => {
    window.deliver({ type: "snapshot", state: window.fixtureState });
    window.deliver({ type: "sent", attachmentIds: [] });
  });
  assert.equal(
    await page
      .locator('#queue [data-steer-index="0"]')
      .evaluate((node) => node.disabled),
    false,
    "A completed send must re-enable steering without another snapshot",
  );
  await prompt.fill("新草稿");
  await page.locator('#queue [data-steer-index="0"]').click();
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "promoteQueued",
    index: 0,
    revision: 7,
  });
  assert.equal(
    await prompt.inputValue(),
    "新草稿",
    "Steering must preserve a new draft",
  );
  assert.equal(
    await page
      .locator('#queue [data-steer-index="0"]')
      .evaluate((node) => node.disabled),
    true,
  );
  await page.evaluate(() => {
    window.fixtureState = {
      ...window.fixtureState,
      queues: {
        steering: ["已有补充", "先检查协议"],
        followUp: ["完成后更新说明"],
      },
      queueControl: { revision: 8, busy: false, canSteer: true },
    };
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  assert.equal(await page.locator("#queue [data-steer-index]").count(), 1);
  await page.locator('#queue [data-steer-index="0"]').focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
    type: "promoteQueued",
    index: 0,
    revision: 8,
  });
  await page.evaluate(() => {
    window.fixtureState = {
      ...window.fixtureState,
      queueControl: {
        revision: 8,
        busy: false,
        canSteer: false,
        reason: "队列含图片，暂不支持引导。",
      },
    };
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  assert.equal(
    await page
      .locator('#queue [data-steer-index="0"]')
      .evaluate((node) => node.disabled),
    true,
  );
  assert.match(await page.locator("#queue").textContent(), /图片/);
  await page.evaluate(() => {
    window.fixtureState = {
      ...window.fixtureState,
      queueControl: { revision: 8, busy: true, canSteer: false },
    };
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  assert.equal(
    await page.locator("#send").evaluate((node) => node.disabled),
    true,
  );
  assert.equal(
    await page
      .locator('[data-action="stop"]')
      .evaluate((node) => node.disabled),
    false,
  );
  await page.evaluate(() => {
    window.fixtureState = {
      ...window.fixtureState,
      queueControl: { revision: 9, busy: false, canSteer: true },
    };
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  await page.locator("[data-copy-text]").last().click();
  assert.equal(
    await page.evaluate(() => window.actions.at(-1).type),
    "copyText",
  );
  await page.locator("[data-code-text]").click();
  assert.equal(
    await page.evaluate(() => window.actions.at(-1).type),
    "openCode",
  );
  await page.locator("a[data-reference]").click();
  assert.equal(
    await page.evaluate(() => window.actions.at(-1).reference),
    "main.ts:2",
  );
  await page.locator("#sessions").click();
  await page.locator("#history-search input").fill("two");
  assert.equal(await page.locator("[data-select-session]").count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#history-panel").isVisible(), false);
  await page.evaluate(() => {
    window.fixtureState = { ...window.fixtureState, run: "running" };
    window.deliver({ type: "snapshot", state: window.fixtureState });
  });
  const working = page.locator("#activity .working");
  await working.waitFor();
  assert.equal(await working.textContent(), "Working");
  const workingNode = await working.elementHandle();
  const spinnerFrame = () =>
    page
      .locator(".working-spinner")
      .evaluate((node) => getComputedStyle(node, "::before").content);
  const firstFrame = await spinnerFrame();
  await page.waitForFunction(
    (first) =>
      getComputedStyle(document.querySelector(".working-spinner"), "::before")
        .content !== first,
    firstFrame,
  );
  await page.evaluate(() =>
    window.deliver({ type: "snapshot", state: window.fixtureState }),
  );
  assert.ok(
    await workingNode.evaluate(
      (node) => node === document.querySelector(".working"),
    ),
    "Streaming updates should preserve the active spinner",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".working-spinner")
      .evaluate((node) => getComputedStyle(node, "::before").animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // A long transcript must keep historical selection, focus and scroll while
  // only the active reply changes. This remains a browser fixture, not PI E2E.
  const streaming = await page.evaluate(() => {
    const original = window.fixtureState;
    const state = structuredClone(original);
    state.messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content:
        `第 ${index} 条历史消息。` +
        "保留历史正文与代码。".repeat(30) +
        (index % 2 ? "\n\n```ts\nconst answer = 42;\n```" : ""),
    }));
    state.messages.push({ role: "assistant", content: "正在生成" });
    window.deliver({ type: "snapshot", state });
    const transcript = document.getElementById("transcript");
    const historical = [...transcript.children].slice(0, 100);
    const paragraph = historical[1].querySelector(".markdown p");
    const button = historical[1].querySelector("button");
    button.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    transcript.scrollTop = 100;
    const scrollTop = transcript.scrollTop;
    const samples = [];
    for (let index = 0; index < 30; index++) {
      const next = structuredClone(state);
      next.messages.at(-1).content += " 流式新增内容".repeat(index + 1);
      const start = performance.now();
      window.deliver({ type: "snapshot", state: next });
      samples.push(performance.now() - start);
    }
    const result = {
      historicalMessages: 100,
      updates: samples.length,
      retainedNodes: historical.filter(
        (node, index) => node === transcript.children[index],
      ).length,
      preservedFocus: document.activeElement === button,
      preservedSelection: selection.toString() === paragraph.textContent,
      preservedScroll: Math.abs(transcript.scrollTop - scrollTop) < 2,
      medianMs: samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)],
      maxMs: Math.max(...samples),
    };
    window.deliver({ type: "snapshot", state: original });
    return result;
  });
  assert.equal(
    streaming.retainedNodes,
    100,
    "Streaming must retain historical message nodes",
  );
  assert.equal(streaming.preservedFocus, true);
  assert.equal(streaming.preservedSelection, true);
  assert.equal(streaming.preservedScroll, true);
  console.log(`Streaming fixture: ${JSON.stringify(streaming)}`);
  for (const [theme, colors] of Object.entries(themes)) {
    for (const width of [320, 480])
      for (const zoom of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          ({ theme, colors, zoom }) => {
            document.body.className =
              theme === "contrast" ? "vscode-high-contrast" : `vscode-${theme}`;
            const style = document.documentElement.style;
            for (const [key, value] of Object.entries({
              "sideBar-background": colors.bg,
              foreground: colors.fg,
              descriptionForeground: colors.muted,
              "panel-border": colors.border,
              focusBorder: colors.focus,
              "textLink-foreground": colors.accent,
              errorForeground: theme === "light" ? "#b42318" : "#f48771",
              contrastBorder: colors.border,
              "font-size": "13px",
              "input-background": colors.bg,
              "input-foreground": colors.fg,
            }))
              style.setProperty(`--vscode-${key}`, value);
            document.body.style.zoom = String(zoom);
            for (const button of document.querySelectorAll("button"))
              button.style.transition = "none";
          },
          { theme, colors, zoom },
        );
        const palette = await page.evaluate(() => {
          const style = getComputedStyle(document.body);
          return {
            accent: style.getPropertyValue("--pi-accent").trim(),
            focus: style.getPropertyValue("--pi-focus").trim(),
            selectionText: style.getPropertyValue("--pi-selection-text").trim(),
          };
        });
        const expectedAccent =
          theme === "dark"
            ? "#e1b06e"
            : theme === "light"
              ? "#844f3b"
              : colors.accent;
        assert.equal(palette.accent, expectedAccent);
        assert.equal(
          palette.focus,
          theme === "contrast" ? colors.focus : expectedAccent,
        );
        if (theme !== "contrast")
          assert.equal(palette.selectionText, expectedAccent);
        // A real browser verifies native disclosure behavior and compact tool rows.
        await page.evaluate(() => {
          const tools = Array.from({ length: 7 }, (_, index) => ({
            id: `process-${index}`,
            name:
              index === 4
                ? "mcp__provider__" + "long_tool_name_".repeat(20)
                : index % 2
                  ? "bash"
                  : "read",
            args:
              index % 2
                ? {
                    command:
                      "npm run check && npm test -- --reporter=verbose " +
                      "long-argument ".repeat(30),
                  }
                : { path: `src/features/example-${index}.ts` },
            status: index === 6 ? "error" : "success",
            result: {
              content: [
                {
                  type: "text",
                  text: index === 6 ? "示例错误：文件不存在" : "示例工具输出",
                },
              ],
            },
          }));
          window.processFixture = {
            ...window.fixtureState,
            run: "idle",
            messages: [
              { role: "user", content: "看看这个项目" },
              { role: "assistant", content: "我先阅读项目文件，再检查构建。" },
              ...tools.map((tool) => ({
                role: "assistant",
                content: [{ type: "toolCall", id: tool.id, name: tool.name }],
              })),
              {
                role: "assistant",
                content:
                  "项目结构已经梳理完成。你可以展开执行过程查看命令和错误详情。",
              },
            ],
            tools,
          };
          window.deliver({ type: "snapshot", state: window.processFixture });
        });
        const execution = page.locator(".execution");
        const executionSummary = execution.locator(":scope > summary");
        assert.equal(await execution.count(), 1);
        assert.match(
          await executionSummary.getAttribute("aria-label"),
          /7 项操作 · 1 项失败/,
        );
        assert.equal(await execution.evaluate((node) => node.open), false);
        assert.equal(await page.locator(".tool").first().isVisible(), false);
        assert.equal(
          await page
            .locator("#transcript > .assistant-message .markdown")
            .isVisible(),
          true,
        );
        await executionSummary.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            artifacts,
            `process-collapsed-${theme}-${width}-${zoom}.png`,
          ),
          fullPage: true,
        });
        await executionSummary.focus();
        await page.keyboard.press("Enter");
        assert.equal(await execution.evaluate((node) => node.open), true);
        await execution
          .locator(".execution-body")
          .evaluate((node) =>
            Promise.all(
              node.getAnimations().map((animation) => animation.finished),
            ),
          );
        await executionSummary.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            artifacts,
            `process-overview-${theme}-${width}-${zoom}.png`,
          ),
          fullPage: true,
        });
        const commandSummary = page
          .locator(".tool")
          .nth(1)
          .locator(":scope > summary");
        await commandSummary.scrollIntoViewIfNeeded();
        const commandLayout = await commandSummary.evaluate((node) => {
          const target = node.querySelector(".tool-target");
          return {
            height: node.getBoundingClientRect().height,
            lineHeight:
              parseFloat(getComputedStyle(node).lineHeight) *
              parseFloat(document.body.style.zoom || "1"),
            truncated: target.scrollWidth > target.clientWidth,
          };
        });
        assert.ok(
          commandLayout.truncated,
          "Long commands must be visually truncated",
        );
        assert.ok(
          commandLayout.height < commandLayout.lineHeight + 20 * zoom,
          "Tool headers must stay on one line",
        );
        await commandSummary.focus();
        await page.keyboard.press("Space");
        assert.equal(
          await page
            .locator(".tool")
            .nth(1)
            .evaluate((node) => node.open),
          true,
        );
        assert.equal(
          await page
            .locator(".tool")
            .nth(1)
            .locator(".tool-output")
            .isVisible(),
          true,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
          ),
          false,
          `Process overflow: ${theme} ${width} ${zoom}`,
        );
        await executionSummary.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            artifacts,
            `process-expanded-${theme}-${width}-${zoom}.png`,
          ),
          fullPage: true,
        });
        await page.evaluate(() => {
          window.deliver({
            type: "snapshot",
            state: {
              ...window.processFixture,
              run: "running",
              messages: window.processFixture.messages.slice(0, -1),
              tools: window.processFixture.tools.map((tool, index) =>
                index === 6
                  ? { ...tool, status: "pending", result: undefined }
                  : tool,
              ),
            },
          });
        });
        assert.match(await executionSummary.textContent(), /正在执行/);
        assert.equal(await execution.evaluate((node) => node.open), true);
        assert.equal(
          await page
            .locator(".tool")
            .nth(1)
            .evaluate((node) => node.open),
          true,
        );
        await executionSummary.focus();
        await page.keyboard.press("Enter");
        assert.equal(await execution.evaluate((node) => node.open), false);
        assert.equal(
          await execution.locator(".execution-failure").isVisible(),
          false,
        );
        const icon = execution.locator(".execution-icon");
        assert.equal(
          await icon.evaluate(
            (node) => getComputedStyle(node, "::before").animationName,
          ),
          "execution-orbit",
        );
        assert.equal(
          await executionSummary.evaluate(
            (node) => getComputedStyle(node, "::after").animationName,
          ),
          "execution-sheen",
        );
        await page.screenshot({
          path: join(
            artifacts,
            `process-running-${theme}-${width}-${zoom}.png`,
          ),
          fullPage: true,
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(
          await icon.evaluate(
            (node) => getComputedStyle(node, "::before").animationName,
          ),
          "none",
        );
        assert.equal(
          await executionSummary.evaluate(
            (node) => getComputedStyle(node, "::after").display,
          ),
          "none",
        );
        await executionSummary.focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await execution
            .locator(".execution-body")
            .evaluate((node) => getComputedStyle(node).animationName),
          "none",
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() =>
          window.deliver({ type: "snapshot", state: window.fixtureState }),
        );
        await page.screenshot({
          path: join(artifacts, `${theme}-${width}-${zoom}.png`),
          fullPage: true,
        });
        const color = await page
          .locator("button.content-action")
          .first()
          .evaluate((node) => getComputedStyle(node).color);
        assert.equal(
          color,
          {
            dark: "rgb(160, 160, 160)",
            light: "rgb(97, 97, 97)",
            contrast: "rgb(255, 255, 255)",
          }[theme],
        );
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        assert.equal(
          overflow,
          false,
          `Horizontal overflow: ${theme} ${width} ${zoom}`,
        );
        const clippedControls = await page.evaluate(() => {
          const composer = document
            .querySelector(".composer")
            .getBoundingClientRect();
          return [
            ...document.querySelectorAll(".attach-actions wa-button, #send"),
          ]
            .filter((node) => {
              const bounds = node.getBoundingClientRect();
              return (
                bounds.left < composer.left - 1 ||
                bounds.right > composer.right + 1
              );
            })
            .map((node) => node.id || node.textContent);
        });
        assert.deepEqual(
          clippedControls,
          [],
          `Clipped composer controls: ${theme} ${width} ${zoom}`,
        );
        await page.locator("#settings-toggle").click();
        await page.locator("#settings-panel").waitFor();
        await page.screenshot({
          path: join(artifacts, `settings-${theme}-${width}-${zoom}.png`),
          fullPage: true,
        });
        const panelBounds = await page.locator("#settings-panel").boundingBox();
        assert.ok(
          panelBounds &&
            panelBounds.x >= -1 &&
            panelBounds.x + panelBounds.width <= width + 1,
          `Settings panel overflow: ${theme} ${width} ${zoom}`,
        );
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#settings-panel").isVisible(), false);
        await prompt.fill("/");
        await page.locator("#command-menu").waitFor();
        await page
          .locator("#command-menu [role=option]")
          .filter({ hasText: "/stop ·" })
          .scrollIntoViewIfNeeded();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
          ),
          false,
          `Slash menu overflow: ${theme} ${width} ${zoom}`,
        );
        await page.screenshot({
          path: join(artifacts, `commands-${theme}-${width}-${zoom}.png`),
          fullPage: true,
        });
        await prompt.press("Escape");
        await prompt.fill("保留草稿");
        const steer = page.locator('#queue [data-steer-index="0"]');
        await steer.scrollIntoViewIfNeeded();
        assert.equal(await steer.isVisible(), true);
        const rowLayout = await steer.evaluate((node) => {
          const row = node.closest(".queue-item");
          const text = row.querySelector(".queue-text").getBoundingClientRect();
          const button = node.shadowRoot
            .querySelector('[part~="base"]')
            .getBoundingClientRect();
          return {
            display: getComputedStyle(row).display,
            textTop: text.top,
            buttonTop: button.top,
          };
        });
        assert.equal(rowLayout.display, "flex");
        assert.ok(
          Math.abs(rowLayout.textTop - rowLayout.buttonTop) < 5,
          "Steer must sit beside the text",
        );
        const bounds = await steer.boundingBox();
        assert.ok(
          bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
          `Steering button overflow: ${theme} ${width} ${zoom}`,
        );
        for (const menu of ["model-menu", "thinking-menu"]) {
          await page.locator(`#${menu} [slot="trigger"]`).click();
          const states = await page
            .locator(`#${menu} wa-dropdown-item`)
            .evaluateAll((nodes) =>
              nodes.map((node) => ({
                checked: node.checked,
                checkDisplay: getComputedStyle(
                  node.shadowRoot.querySelector('[part="checkmark"]'),
                ).display,
                background: getComputedStyle(node).backgroundColor,
              })),
            );
          assert.ok(
            states.some(
              (state) =>
                state.checked && state.background !== "rgba(0, 0, 0, 0)",
            ),
          );
          assert.ok(states.every((state) => state.checkDisplay === "none"));
          await page.keyboard.press("Escape");
          await page
            .locator(`#${menu} [part="menu"]`)
            .waitFor({ state: "hidden" });
        }
        await page.evaluate(() => {
          window.beforeFork = window.fixtureState;
          window.deliver({
            type: "snapshot",
            state: {
              ...window.fixtureState,
              run: "idle",
              messages: [],
              tools: [],
              queues: { steering: [], followUp: [] },
              editorText: {
                text: "你好",
                focus: true,
                revision: (window.forkRevision =
                  (window.forkRevision ?? 1) + 1),
              },
            },
          });
        });
        assert.equal(await prompt.inputValue(), "你好");
        const forkBounds = await prompt.boundingBox();
        assert.ok(
          forkBounds &&
            forkBounds.y >= -1 &&
            forkBounds.y + forkBounds.height <= 1001,
          `Fork prompt clipped: ${theme} ${width} ${zoom}: ${JSON.stringify(forkBounds)}`,
        );
        assert.equal(
          await prompt.evaluate(
            (node) => node === node.getRootNode().activeElement,
          ),
          true,
        );
        await page.screenshot({
          path: join(artifacts, `fork-${theme}-${width}-${zoom}.png`),
          fullPage: true,
        });
        await page.evaluate(() => {
          window.deliver({ type: "snapshot", state: window.beforeFork });
          window.scrollTo(0, 0);
        });
        await page.locator("#shell-panel summary").click();
        await page.locator("#shell-output").scrollIntoViewIfNeeded();
        assert.equal(await page.locator("#shell-output").isVisible(), true);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
          ),
          false,
          `Bash panel overflow: ${theme} ${width} ${zoom}`,
        );
        await page.screenshot({
          path: join(artifacts, `shell-${theme}-${width}-${zoom}.png`),
          fullPage: true,
        });
        await page.locator("#shell-panel summary").click();
        await page.evaluate(() =>
          window.deliver({
            type: "snapshot",
            state: {
              ...window.fixtureState,
              run: "idle",
              compaction: { active: true },
              stats: {
                tokens: { total: 123456 },
                cost: 0.1234,
                contextUsage: { percent: 45.6 },
              },
            },
          }),
        );
        await usage.scrollIntoViewIfNeeded();
        assert.equal(await usage.isDisabled(), true);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
          ),
          false,
          `Usage overflow: ${theme} ${width} ${zoom}`,
        );
        await page.screenshot({
          path: join(artifacts, `compact-${theme}-${width}-${zoom}.png`),
          fullPage: true,
        });
        await page.evaluate(() =>
          window.deliver({ type: "snapshot", state: window.fixtureState }),
        );
      }
  }
  assert.deepEqual(failures, []);
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify({ passed: true, cases: 12, streaming, failures }, null, 2),
  );
  await page.evaluate(() =>
    window.deliver({
      type: "snapshot",
      state: { ...window.fixtureState, run: "idle" },
    }),
  );
  assert.equal(await page.locator("#activity .working").count(), 0);
  console.log(
    `Webview interactions and 12 render cases passed. Browser fixture screenshots: ${artifacts}`,
  );
} finally {
  await browser.close();
  server.close();
}
