import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("fake-pi 1.5.2");
  process.exit(0);
}
const input = createInterface({ input: process.stdin });
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
input.on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "extension_ui_response") return;
  if (cmd.type === "get_entries") {
    process.stdout.write("not a JSON record\n");
    return;
  }
  const state = {
    sessionId: "fake-session",
    sessionFile: process.cwd() + "/fake.jsonl",
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    model: { id: "fake", provider: "test", input: ["text", "image"] },
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "all",
  };
  const data =
    cmd.type === "get_state"
      ? state
      : cmd.type === "get_messages"
        ? { messages: [] }
        : cmd.type === "get_available_models"
          ? { models: [state.model] }
          : cmd.type === "get_available_thinking_levels"
            ? { levels: ["off", "medium"] }
            : cmd.type === "get_commands"
              ? { commands: [] }
              : cmd.type === "cycle_model"
                ? {
                    model: state.model,
                    thinkingLevel: "medium",
                    isScoped: false,
                  }
                : cmd.type === "cycle_thinking_level"
                  ? { level: "off" }
                  : cmd.type === "clear_queue"
                    ? { steering: [], followUp: [] }
                    : {};
  emit({
    id: cmd.id,
    type: "response",
    command: cmd.type,
    success: true,
    data,
  });
});
input.on("close", () => process.exit(0));
