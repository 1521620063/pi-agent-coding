import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const mode = (await readFile("rpc-fixture-mode", "utf8")).trim();
if (process.argv.includes("--version")) {
  if (mode === "slow-version") {
    process.stderr.write(`version-ready:${process.pid}\n`);
    setInterval(() => {}, 1000);
  } else {
    console.log("fixture 1.5.2");
    process.exit(0);
  }
} else {
  const order = [];
  const descendant =
    mode === "stubborn"
      ? spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          stdio: "ignore",
          windowsHide: true,
        })
      : undefined;
  if (mode === "stubborn") setInterval(() => {}, 1000);
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const command = JSON.parse(line);
    if (mode === "slow-handshake") {
      process.stderr.write(`handshake-ready:${process.pid}\n`);
      return;
    }
    if (command.type === "malformed") {
      process.stdout.write("invalid JSON\n");
      return;
    }
    if (command.type === "hold") return;
    order.push(command.type);
    const data =
      command.type === "get_state"
        ? {
            sessionId: "lifecycle-fixture",
            sessionFile: `${process.cwd()}/session.jsonl`,
            isStreaming: false,
            isCompacting: false,
            autoCompactionEnabled: true,
            thinkingLevel: "medium",
            model: { id: "fake", provider: "fixture", input: ["text"] },
            cwd: process.cwd(),
            childPid: descendant?.pid,
          }
        : command.type === "order"
          ? { order }
          : {};
    const records = [
      {
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
        data,
      },
    ];
    if (mode === "subscriber-failure" && command.type === "get_state")
      records.push({ type: "agent_start" });
    process.stdout.write(
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  });
  input.on("close", () => {
    if (mode !== "stubborn") process.exit(0);
  });
}
