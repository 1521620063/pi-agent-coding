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
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'nonce-fixture';"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/webview.css"></head><body><div id="app"></div><script nonce="fixture" type="module" src="/fixture.js"></script></body></html>`,
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
  await page.locator("#model-name").filter({ hasText: "test" }).waitFor();
  const prompt = page.locator("#prompt textarea");
  assert.equal(await prompt.inputValue(), "保留草稿");
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
  assert.equal(await prompt.inputValue(), "/beta ");
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
      }
  }
  assert.deepEqual(failures, []);
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify({ passed: true, cases: 12, failures }, null, 2),
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
