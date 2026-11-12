import type { ExtensionUiRequest, ExtensionUiResponse } from "../pi/protocol";
import type { SessionStore } from "../state/session-store";
export type UiAnswer =
  { value: string } | { confirmed: boolean } | { cancelled: true };
export class ExtensionUiManager {
  private seen = new Set<string>();
  private pending = new Map<
    string,
    { record: ExtensionUiRequest; timer?: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private store: SessionStore,
    private send: (response: ExtensionUiResponse) => Promise<void>,
    private show?: (request: ExtensionUiRequest) => Promise<UiAnswer>,
    private notify: (request: ExtensionUiRequest) => void = () => {},
  ) {}
  handle(record: ExtensionUiRequest): void {
    const state = this.store.getSnapshot();
    if (["select", "confirm", "input", "editor"].includes(record.method)) {
      if (this.seen.has(record.id)) return;
      this.seen.add(record.id);
      const item = {
        record,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      if (record.timeout !== undefined && Number.isFinite(record.timeout))
        item.timer = setTimeout(
          () => this.expire(record.id),
          Math.max(0, record.timeout),
        );
      this.pending.set(record.id, item);
      this.publish();
      if (this.show) {
        const reply = (answer: UiAnswer) => {
          if (this.pending.get(record.id) === item)
            return this.reply(record.id, answer);
        };
        void this.show(record)
          .then(reply)
          .catch(() => reply({ cancelled: true }));
      }
    } else if (
      record.method === "setStatus" &&
      typeof record.statusKey === "string"
    ) {
      const statuses = { ...state.statuses };
      if (typeof record.statusText === "string")
        statuses[record.statusKey] = record.statusText;
      else delete statuses[record.statusKey];
      this.store.update({ statuses });
    } else if (
      record.method === "setWidget" &&
      typeof record.widgetKey === "string"
    ) {
      const widgets = { ...state.widgets };
      if (
        Array.isArray(record.widgetLines) &&
        record.widgetLines.every((line: unknown) => typeof line === "string")
      )
        widgets[record.widgetKey] = {
          lines: record.widgetLines,
          placement:
            record.widgetPlacement === "belowEditor"
              ? "belowEditor"
              : "aboveEditor",
        };
      else delete widgets[record.widgetKey];
      this.store.update({ widgets });
    } else if (record.method === "setTitle" && typeof record.title === "string")
      this.store.update({ title: record.title });
    else if (
      record.method === "set_editor_text" &&
      typeof record.text === "string"
    )
      this.store.update({
        editorText: {
          text: record.text,
          revision: (state.editorText?.revision ?? 0) + 1,
        },
      });
    else if (record.method === "notify") this.notify(record);
  }
  async reply(id: string, answer: UiAnswer): Promise<void> {
    const item = this.pending.get(id);
    if (!item) return;
    if (
      "value" in answer &&
      (item.record.method === "confirm" ||
        (item.record.method === "select" &&
          !item.record.options?.includes(answer.value)))
    )
      return;
    if ("confirmed" in answer && item.record.method !== "confirm") return;
    this.expire(id);
    await this.send({ type: "extension_ui_response", id, ...answer });
  }
  private expire(id: string) {
    const item = this.pending.get(id);
    clearTimeout(item?.timer);
    this.pending.delete(id);
    this.publish();
  }
  private publish() {
    this.store.update({
      pendingUi: [...this.pending.values()].map((item) => item.record),
    });
  }
  dispose() {
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear();
    this.seen.clear();
    this.publish();
  }
}
