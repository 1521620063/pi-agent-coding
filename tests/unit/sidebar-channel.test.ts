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
  it("validates scoped context actions and rejects extra privileged fields", () => {
    for (const action of [
      { type: "searchFiles", query: "中文", requestId: 2 },
      { type: "attachContext", id: "opaque-id" },
      { type: "openFile", reference: "src/main.ts:3" },
      { type: "openFile", reference: "main.ts:2:3" },
    ])
      expect(parseClientAction(action)).toEqual(action);
    for (const action of [
      { type: "searchFiles", query: "x", requestId: -1 },
      { type: "attachContext", id: "id", path: "secret" },
      { type: "openFile", reference: "command:evil" },
      { type: "openFile", reference: "command:2" },
      { type: "openFile", reference: "\u0000bad" },
    ])
      expect(parseClientAction(action)).toBeUndefined();
  });
  it("strictly validates content, fork and queue operations", () => {
    for (const action of [
      { type: "copyText", text: "code" },
      { type: "openCode", text: "code", language: "typescript" },
      { type: "forkMessage", index: 0 },
      { type: "queueMode", channel: "followUp", mode: "all" },
      { type: "attachDiagnostics" },
    ])
      expect(parseClientAction(action)).toEqual(action);
    for (const action of [
      { type: "copyText", text: "code", path: "secret" },
      { type: "openCode", text: "code", language: "../../file" },
      { type: "forkMessage", index: -1 },
      { type: "forkMessage", index: 0.5 },
      { type: "queueMode", channel: "followUp", mode: "arbitrary" },
      { type: "attachDiagnostics", path: "secret" },
    ])
      expect(parseClientAction(action)).toBeUndefined();
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
