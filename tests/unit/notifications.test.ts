import { expect, it } from "vitest";
import { TaskNotifications } from "../../src/features/notifications";
import { SessionStore } from "../../src/state/session-store";
it("notifies once on settled or waiting in background, never on agent_end", () => {
  const store = new SessionStore();
  const notifier = new TaskNotifications();
  store.apply({ type: "agent_start" });
  notifier.observe(store.getSnapshot(), false);
  store.apply({ type: "agent_end" });
  expect(notifier.observe(store.getSnapshot(), false)).toBeUndefined();
  store.apply({ type: "agent_settled" });
  expect(notifier.observe(store.getSnapshot(), false)).toContain("完成");
  expect(notifier.observe(store.getSnapshot(), false)).toBeUndefined();
  store.update({ pendingUi: [{ id: "wait" }] });
  expect(notifier.observe(store.getSnapshot(), false)).toContain("等待");
  expect(notifier.observe(store.getSnapshot(), false)).toBeUndefined();
});
