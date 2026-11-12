import type { ClientAction, ViewState } from "../src/shared/bridge";
import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import {
  formButton,
  type FormButton,
  type FormInput,
  type FormSelect,
} from "./components";

export function setupSelections(
  root: HTMLElement,
  post: (action: ClientAction) => void,
) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) =>
    root.querySelector<T>(`#${id}`)!;
  const modelMenu = get<WaDropdown>("model-menu");
  const thinkingMenu = get<WaDropdown>("thinking-menu");
  const historyPopup = get<WaPopup>("history-popup");
  const panel = get("history-panel");
  const trigger = get<FormButton>("sessions");
  const settingsPopup = get("settings-popup");
  const settingsPanel = get("settings-panel");
  const settingsTrigger = get<FormButton>("settings-toggle");
  let current: ViewState | undefined;
  let lastModels = "";
  let lastThinking = "";
  let lastHistory = "";
  const search = get<FormInput>("history-search");
  search?.addEventListener("input", () => {
    if (current) {
      lastHistory = "";
      render(current);
    }
  });

  const closeHistory = (restoreFocus = false) => {
    historyPopup.active = false;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  };
  const closeMenus = () => {
    modelMenu.open = false;
    thinkingMenu.open = false;
  };
  const closeSettings = (restoreFocus = false) => {
    settingsPanel.hidden = true;
    settingsTrigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) settingsTrigger.focus();
  };
  settingsTrigger.onclick = () => {
    if (!settingsPanel.hidden) return closeSettings();
    closeHistory();
    closeMenus();
    settingsPanel.hidden = false;
    settingsTrigger.setAttribute("aria-expanded", "true");
    settingsPanel.focus();
  };
  get("settings-close").onclick = () => closeSettings(true);
  trigger.onclick = () => {
    if (current?.connection !== "connected") return;
    if (!panel.hidden) return closeHistory();
    closeMenus();
    closeSettings();
    historyPopup.active = true;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    panel.focus();
    post({ type: "sessions" });
  };
  get("history-open").onclick = () => {
    closeHistory(true);
    post({ type: "openSession" });
  };
  document.addEventListener("pointerdown", (event) => {
    if (!event.composedPath().includes(historyPopup)) closeHistory();
    if (!event.composedPath().includes(settingsPopup)) closeSettings();
  });
  document.addEventListener("focusin", (event) => {
    if (!event.composedPath().includes(historyPopup)) closeHistory();
    if (!event.composedPath().includes(settingsPopup)) closeSettings();
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "Escape" ||
        settingsPanel.hidden ||
        event.defaultPrevented
      )
        return;
      // Selects stop keydown propagation even when closed. Capture Escape here,
      // but let an open select close its own options before dismissing the panel.
      if (
        Array.from(
          settingsPanel.querySelectorAll<FormSelect>("wa-select"),
        ).some((select) => select.open)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      closeSettings(true);
    },
    { capture: true },
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      closeHistory(true);
    }
  });
  for (const menu of [modelMenu, thinkingMenu]) {
    menu.addEventListener("wa-show", () => {
      closeHistory();
      closeSettings();
      (menu === modelMenu ? thinkingMenu : modelMenu).open = false;
      post({ type: "refreshModels" });
    });
  }
  modelMenu.addEventListener("wa-select", (event) => {
    const item = (event as WaSelectEvent).detail.item as WaDropdownItem;
    const model = current?.models.find(
      (_, index) => String(index) === item.getAttribute("value"),
    );
    modelMenu.open = false;
    item.checked =
      !!model &&
      model.provider === current?.model?.provider &&
      model.id === current?.model?.id;
    if (model && current?.connection === "connected")
      post({
        type: "chooseModel",
        provider: model.provider,
        modelId: model.id,
      });
  });
  thinkingMenu.addEventListener("wa-select", (event) => {
    const item = (event as WaSelectEvent).detail.item as WaDropdownItem;
    const level = current?.thinkingLevels.find(
      (level) => level === item.getAttribute("value"),
    );
    thinkingMenu.open = false;
    item.checked = !!level && level === current?.thinkingLevel;
    if (level && current?.connection === "connected")
      post({ type: "chooseThinking", level });
  });
  const menuItem = (label: string, value: string, checked: boolean) => {
    const item = document.createElement("wa-dropdown-item");
    item.textContent = label;
    item.value = value;
    item.setAttribute("value", value);
    item.type = "checkbox";
    item.checked = checked;
    return item;
  };
  const replaceItems = (
    menu: WaDropdown,
    items: HTMLElement[],
    empty: string,
  ) => {
    for (const item of menu.querySelectorAll("wa-dropdown-item")) item.remove();
    if (!items.length) {
      const item = document.createElement("wa-dropdown-item");
      item.textContent = empty;
      item.disabled = true;
      items.push(item);
    }
    menu.append(...items);
  };
  function render(state: ViewState) {
    current = state;
    const connected = state.connection === "connected";
    trigger.disabled = !connected;
    if (!connected) {
      closeHistory();
      closeMenus();
    }
    const modelsKey = JSON.stringify([state.models, state.model]);
    if (modelsKey !== lastModels) {
      lastModels = modelsKey;
      replaceItems(
        modelMenu,
        state.models.map((model, index) => {
          const item = menuItem(
            model.name ?? model.id,
            String(index),
            model.provider === state.model?.provider &&
              model.id === state.model?.id,
          );
          const provider = document.createElement("span");
          provider.slot = "details";
          provider.textContent = model.provider;
          item.append(provider);
          item.title = `${model.name ?? model.id} · ${model.provider}`;
          return item;
        }),
        "暂无可用模型",
      );
    }
    const thinkingKey = JSON.stringify([
      state.thinkingLevels,
      state.thinkingLevel,
    ]);
    if (thinkingKey !== lastThinking) {
      lastThinking = thinkingKey;
      replaceItems(
        thinkingMenu,
        state.thinkingLevels.map((level) =>
          menuItem(level, level, level === state.thinkingLevel),
        ),
        "暂无可用思考强度",
      );
    }
    const historyKey = JSON.stringify([
      search?.value,
      state.workspace,
      state.sessions,
      state.session?.path,
    ]);
    if (historyKey === lastHistory) return;
    lastHistory = historyKey;
    const list = get("history-list");
    const hadFocus = list.contains(document.activeElement);
    list.replaceChildren();
    const query = (search?.value ?? "").toLocaleLowerCase();
    const sessions =
      state.sessions?.filter((session) =>
        [session.name, session.sessionId, session.sessionPath].some((value) =>
          value?.toLocaleLowerCase().includes(query),
        ),
      ) ?? [];
    if (!sessions.length) {
      const empty = document.createElement("p");
      empty.className = "muted history-empty";
      empty.textContent = query ? "没有匹配的会话" : "当前工作区暂无历史记录";
      list.append(empty);
    }
    for (const session of sessions) {
      const row = document.createElement("div");
      row.className = "history-row";
      const open = formButton(
        session.name ?? session.sessionId,
        "history-session",
      );
      open.dataset.selectSession = session.sessionPath;
      open.title = `${session.name ?? session.sessionId}\n${session.lastOpenedAt}`;
      if (session.sessionPath === state.session?.path)
        open.setAttribute("aria-current", "true");
      open.onclick = () => {
        closeHistory(true);
        post({ type: "selectSession", sessionPath: session.sessionPath });
      };
      const remove = formButton("×", "history-remove");
      remove.dataset.removeSession = session.sessionPath;
      remove.setAttribute(
        "aria-label",
        `移除历史记录：${session.name ?? session.sessionId}`,
      );
      remove.title = "移除历史记录（保留 PI 会话文件）";
      remove.onclick = () =>
        post({ type: "removeSession", sessionPath: session.sessionPath });
      row.append(open, remove);
      list.append(row);
    }
    if (hadFocus && !panel.hidden) panel.focus();
  }
  return {
    render,
    show(control: "model" | "thinking" | "history" | "settings") {
      if (control === "settings") {
        if (settingsPanel.hidden) settingsTrigger.click();
        else settingsPanel.focus();
      } else if (control === "history") {
        if (panel.hidden) trigger.click();
        else panel.focus();
      } else if (current?.connection === "connected") {
        (control === "model" ? modelMenu : thinkingMenu).open = true;
      }
    },
  };
}
