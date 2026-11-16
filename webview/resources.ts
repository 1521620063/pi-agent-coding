import type { ClientAction, ViewState } from "../src/shared/bridge";
import type {
  ResourceItem,
  ResourceKind,
  ResourceOperation,
  ResourceScope,
  ResourceSnapshot,
} from "../src/shared/resources";
import { formButton, type FormInput, type FormSelect } from "./components";
import "./resources.css";

export const resourceMarkup = `<dialog id="resources-dialog" aria-labelledby="resources-title">
  <div class="resources-heading"><strong id="resources-title">PI 资源管理</strong><wa-button id="resources-close" size="s" appearance="plain" variant="neutral" aria-label="关闭资源管理">关闭</wa-button></div>
  <p class="muted resources-intro">管理 PI 原有配置。保存后可在空闲时重新连接应用。</p>
  <div class="resources-tabs" role="group" aria-label="资源类型">
    <wa-button data-resource-tab="mcp" size="s" appearance="outlined">MCP</wa-button>
    <wa-button data-resource-tab="skills" size="s" appearance="plain">Skills</wa-button>
    <wa-button data-resource-tab="extensions" size="s" appearance="plain">扩展与包</wa-button>
  </div>
  <div class="resources-controls">
    <wa-select id="resources-scope" size="s" label="管理作用域" value="project"><wa-option value="project">当前项目</wa-option><wa-option value="user">用户级</wa-option></wa-select>
    <wa-input id="resources-search" size="s" label="筛选资源" placeholder="名称或路径" clearable></wa-input>
  </div>
  <p id="resources-location" class="muted"></p>
  <div id="resources-toolbar" class="resource-actions"></div>
  <div id="resources-feedback" role="status" aria-live="polite"></div>
  <div id="resources-error" role="alert" hidden></div>
  <details id="resources-warnings" hidden><summary>配置与扫描提示</summary><ul></ul></details>
  <div id="resources-list" aria-label="资源列表"></div>
  <p id="resources-limit" class="muted"></p>
  <div class="resources-bottom"><wa-button id="resources-stop" size="s" appearance="plain" variant="neutral" hidden>停止全部</wa-button><wa-button id="resources-apply" size="s" variant="brand" appearance="outlined">重新连接并应用</wa-button><span id="resources-pending" class="muted"></span></div>
</dialog>`;
const operationLabels: Partial<Record<ResourceOperation, string>> = {
  open: "打开来源",
  edit: "编辑配置",
  toggle: "切换启用",
  exposure: "工具暴露方式",
  projectOverride: "项目启用设置",
  remove: "移除",
  filters: "资源过滤",
  update: "更新包",
  login: "登录",
  logout: "退出登录",
};
export function setupResources(
  root: HTMLElement,
  post: (action: ClientAction) => void,
) {
  const dialog = root.querySelector<HTMLDialogElement>("#resources-dialog")!;
  const scope = root.querySelector<FormSelect>("#resources-scope")!;
  const search = root.querySelector<FormInput>("#resources-search")!;
  let kind: ResourceKind = "mcp";
  let snapshot: ResourceSnapshot | undefined;
  let localBusy = false;
  let live: ViewState | undefined;
  const byId = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const action = (operation: ResourceOperation, item?: ResourceItem) => {
    if (localBusy || snapshot?.busy) return;
    localBusy = true;
    post({
      type: "resourceAction",
      operation,
      kind: item?.kind ?? kind,
      scope: item?.scope ?? (scope.value === "user" ? "user" : "project"),
      ...(item ? { id: item.id } : {}),
    });
    render();
  };
  byId("resources-close").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    localBusy = false;
  });
  scope.addEventListener("change", render);
  search.addEventListener("input", render);
  for (const tab of root.querySelectorAll<HTMLElement>("[data-resource-tab]"))
    tab.onclick = () => {
      kind = tab.dataset.resourceTab as ResourceKind;
      for (const other of root.querySelectorAll<HTMLElement>(
        "[data-resource-tab]",
      )) {
        other.setAttribute("appearance", other === tab ? "outlined" : "plain");
        other.setAttribute("aria-pressed", String(other === tab));
      }
      render();
    };
  byId("resources-stop").onclick = () => post({ type: "stop" });
  byId("resources-apply").onclick = () => action("apply");
  function button(
    label: string,
    operation: ResourceOperation,
    item?: ResourceItem,
  ) {
    const button = formButton(label);
    button.disabled = localBusy || !!snapshot?.busy;
    button.onclick = () => action(operation, item);
    return button;
  }
  function render() {
    if (!snapshot) return;
    const busy = localBusy || snapshot.busy;
    byId("resources-location").textContent =
      scope.value === "user" ? snapshot.agentDir : snapshot.workspace;
    const toolbar = byId("resources-toolbar");
    toolbar.replaceChildren();
    if (kind === "mcp") {
      toolbar.append(
        button("添加 MCP", "addMcp"),
        button("独立连接诊断…", "diagnose"),
      );
    } else if (kind === "skills") {
      toolbar.append(
        button("新建 Skill", "createSkill"),
        button("添加本地路径", "addPath"),
        button("安装资源包…", "install"),
      );
    } else {
      toolbar.append(
        button("添加本地扩展", "addPath"),
        button("安装 PI 包…", "install"),
        button("更新全部包…", "updateAll"),
        button("PI 包清单…", "listPackages"),
      );
    }
    toolbar.append(
      button("打开配置", "openConfig"),
      button("PI 配置终端…", "configure"),
      button("刷新", "refresh"),
    );
    byId("resources-feedback").textContent = busy
      ? "正在处理…请完成编辑器提示或查看任务终端。"
      : (snapshot.notice ?? "");
    byId("resources-error").hidden = !snapshot.error;
    byId("resources-error").textContent = snapshot.error ?? "";
    byId("resources-warnings").hidden = !snapshot.warnings.length;
    const warnings = byId("resources-warnings").querySelector("ul")!;
    warnings.replaceChildren(
      ...snapshot.warnings.map((warning) => {
        const li = document.createElement("li");
        li.textContent = warning;
        return li;
      }),
    );
    const list = byId("resources-list");
    list.replaceChildren();
    const query = (search.value ?? "").trim().toLowerCase();
    const items = snapshot.items.filter(
      (item) =>
        item.scope === scope.value &&
        (item.kind === kind ||
          (kind === "extensions" && item.kind === "packages")) &&
        (!query ||
          `${item.name} ${item.detail} ${item.path ?? ""}`
            .toLowerCase()
            .includes(query)),
    );
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "没有匹配的资源。可添加资源、打开配置或调整筛选。";
      list.append(empty);
    }
    for (const item of items) {
      const row = document.createElement("article");
      row.className = "resource-item";
      const title = document.createElement("strong");
      title.textContent = item.name;
      const status = document.createElement("span");
      status.className = "resource-state";
      status.textContent = item.state;
      const detail = document.createElement("p");
      detail.className = "muted";
      detail.textContent = item.detail;
      row.append(title, status, detail);
      if (item.path) {
        const source = document.createElement("p");
        source.className = "resource-path muted";
        source.textContent = item.path;
        row.append(source);
      }
      const actions = document.createElement("div");
      actions.className = "resource-actions";
      for (const operation of item.actions) {
        const label =
          operation === "toggle"
            ? item.state.includes("已禁用")
              ? "启用"
              : "禁用"
            : operationLabels[operation];
        if (label) actions.append(button(label, operation, item));
      }
      row.append(actions);
      list.append(row);
    }
    byId("resources-limit").textContent =
      kind === "mcp"
        ? "这里显示文件配置；扩展动态注册的 MCP 和侧栏进程的实时连接状态不在此列表。独立诊断会另行连接已启用服务器。"
        : "本地发现、配置规则与 PI 当前命令分别展示。复杂过滤及包身份合并由 PI 处理；命令列表不能代表全部已加载资源。";
    updateApply();
  }
  function updateApply() {
    if (!snapshot) return;
    const busy = localBusy || snapshot.busy;
    byId("resources-stop").hidden =
      !live || (live.run === "idle" && !live.compaction.active);
    const apply = byId("resources-apply") as ReturnType<typeof formButton>;
    const running =
      !!live &&
      (live.run !== "idle" ||
        live.connection === "connecting" ||
        !!live.compaction.active ||
        !!live.shell?.active ||
        !!live.queueControl?.busy ||
        !!live.queues.steering.length ||
        !!live.queues.followUp.length);
    apply.disabled = busy || running || !snapshot.canApply;
    apply.title = apply.disabled
      ? "请等待当前任务、队列及资源管理命令结束"
      : "重新启动当前窗口的 PI 进程，并恢复会话";
    byId("resources-pending").textContent = snapshot.pending
      ? "有配置变更待应用"
      : "修改配置后可重新连接加载";
  }
  return {
    receive(state: ResourceSnapshot, reveal = false) {
      snapshot = state;
      localBusy = false;
      if (reveal && !dialog.open) dialog.showModal();
      render();
    },
    renderLive(state: ViewState) {
      live = state;
      if (dialog.open) updateApply();
    },
  };
}
