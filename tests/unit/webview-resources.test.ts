// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../webview/register-components", () => ({}));
import { resourceMarkup, setupResources } from "../../webview/resources";
import type { ClientAction } from "../../src/shared/bridge";
import type { ResourceSnapshot } from "../../src/shared/resources";
import { SessionStore } from "../../src/state/session-store";

let root: HTMLElement;
let dialog: HTMLDialogElement;
let post: ReturnType<typeof vi.fn<(action: ClientAction) => void>>;
let resources: ReturnType<typeof setupResources>;
const snapshot = (): ResourceSnapshot => ({
  workspace: "C:/workspace",
  agentDir: "C:/agent",
  busy: false,
  pending: false,
  canApply: true,
  warnings: [],
  items: [
    {
      id: "abc1",
      kind: "mcp",
      scope: "project",
      name: "<script>evil()</script>",
      detail: "HTTP",
      state: "配置已禁用",
      actions: ["toggle", "edit"],
    },
    {
      id: "abc2",
      kind: "skills",
      scope: "project",
      name: "example",
      detail: "本地发现",
      state: "按 PI 规则加载",
      actions: ["open", "toggle"],
    },
    {
      id: "abc3",
      kind: "packages",
      scope: "user",
      name: "npm:@example/tools",
      detail: "资源包",
      state: "已配置包",
      actions: ["filters", "remove"],
    },
  ],
});
beforeEach(() => {
  document.body.innerHTML = resourceMarkup;
  root = document.body;
  dialog = root.querySelector("dialog")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    },
  });
  Object.assign(root.querySelector("#resources-scope")!, { value: "project" });
  Object.assign(root.querySelector("#resources-search")!, { value: "" });
  post = vi.fn<(action: ClientAction) => void>();
  resources = setupResources(root, post);
});
const click = (label: string) =>
  [...root.querySelectorAll<HTMLElement>("wa-button")]
    .find((button) => button.textContent === label)!
    .click();

it("renders untrusted resource names as text and emits only opaque row identities", () => {
  resources.receive(snapshot(), true);
  expect(dialog.open).toBe(true);
  expect(root.querySelector("script")).toBeNull();
  expect(root.querySelector("#resources-list")!.textContent).toContain(
    "<script>evil()</script>",
  );
  click("启用");
  expect(post).toHaveBeenCalledWith({
    type: "resourceAction",
    operation: "toggle",
    id: "abc1",
    scope: "project",
    kind: "mcp",
  });
});
it("switches kinds and scopes and filters by name without asking the host to scan", () => {
  resources.receive(snapshot(), true);
  root.querySelector<HTMLElement>('[data-resource-tab="skills"]')!.click();
  expect(root.querySelector("#resources-list")!.textContent).toContain(
    "example",
  );
  expect(root.querySelector("#resources-list")!.textContent).not.toContain(
    "evil",
  );
  root.querySelector<HTMLElement>('[data-resource-tab="extensions"]')!.click();
  const scope = root.querySelector<HTMLElement>("#resources-scope")!;
  Object.assign(scope, { value: "user" });
  scope.dispatchEvent(new Event("change"));
  expect(root.querySelector("#resources-list")!.textContent).toContain(
    "npm:@example/tools",
  );
  const search = root.querySelector<HTMLElement>("#resources-search")!;
  Object.assign(search, { value: "missing" });
  search.dispatchEvent(new Event("input"));
  expect(root.querySelector("#resources-list")!.textContent).toContain(
    "没有匹配",
  );
  expect(post).not.toHaveBeenCalled();
});
it("keeps live chat updates from replacing focused resource controls and preserves stop access", () => {
  resources.receive(snapshot(), true);
  const toggle = [...root.querySelectorAll<HTMLElement>("wa-button")].find(
    (button) => button.textContent === "启用",
  )!;
  const store = new SessionStore();
  store.update({ run: "running" });
  resources.renderLive(store.getSnapshot());
  expect(toggle.isConnected).toBe(true);
  expect((root.querySelector("#resources-apply") as any).disabled).toBe(true);
  expect((root.querySelector("#resources-stop") as HTMLElement).hidden).toBe(
    false,
  );
  click("停止全部");
  expect(post).toHaveBeenCalledWith({ type: "stop" });
  store.update({ run: "idle" });
  resources.renderLive(store.getSnapshot());
  expect((root.querySelector("#resources-apply") as any).disabled).toBe(false);
});
it("does not reopen a closed manager when a background CLI result arrives", () => {
  resources.receive(snapshot(), true);
  click("关闭");
  resources.receive({ ...snapshot(), notice: "CLI 已完成" });
  expect(dialog.open).toBe(false);
  resources.receive(snapshot(), true);
  expect(dialog.open).toBe(true);
});
