import { describe, it, expect } from "vitest";
import { parseClientAction, snapshotMessage } from "../../src/shared/bridge";
import { SessionStore } from "../../src/state/session-store";
describe("host message boundary", () => {
  it("restores the current snapshot on ready", () => {
    const store = new SessionStore();
    expect(parseClientAction({ type: "ready" })).toEqual({ type: "ready" });
    expect(snapshotMessage(store.getSnapshot())).toEqual({
      type: "snapshot",
      state: store.getSnapshot(),
    });
  });
  it("rejects unknown actions and privileged path requests", () => {
    expect(
      parseClientAction({ type: "readFile", path: "C:/secret" }),
    ).toBeUndefined();
    expect(
      parseClientAction({ type: "connect", cwd: "C:/secret" }),
    ).toBeUndefined();
    expect(parseClientAction(null)).toBeUndefined();
  });
  it("validates selections from the sidebar instead of accepting arbitrary payloads", () => {
    for (const action of [
      { type: "chooseModel", provider: "test", modelId: "model" },
      { type: "chooseThinking", level: "high" },
      { type: "selectSession", sessionPath: "session.jsonl" },
      { type: "removeSession", sessionPath: "session.jsonl" },
    ])
      expect(parseClientAction(action)).toEqual(action);
    for (const action of [
      { type: "chooseModel" },
      { type: "chooseModel", provider: "test", modelId: 42 },
      { type: "chooseThinking", level: "arbitrary" },
      { type: "selectSession", sessionPath: "" },
      { type: "removeSession", sessionPath: "a", workspaceUri: "other" },
    ])
      expect(parseClientAction(action)).toBeUndefined();
  });
});
