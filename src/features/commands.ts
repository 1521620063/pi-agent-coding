import type { PiController } from "../pi/controller";
import type { SlashCommand } from "../pi/protocol";
import type { SessionStore } from "../state/session-store";
export class CommandService {
  constructor(
    private pi: Pick<PiController, "request">,
    private store: SessionStore,
  ) {}
  async refresh(): Promise<void> {
    const result = await this.pi.request<{ commands: SlashCommand[] }>({
      type: "get_commands",
    });
    if (!Array.isArray(result.commands))
      throw new Error("Incompatible PI command response");
    this.store.update({
      commands: result.commands.filter(
        (command) =>
          typeof command.name === "string" &&
          ["skill", "prompt", "extension"].includes(command.source),
      ),
    });
  }
  async invoke(
    name: string,
    args: string,
    mode: "steer" | "followUp" = "followUp",
  ): Promise<void> {
    if (
      !this.store
        .getSnapshot()
        .commands.some((command) => command.name === name)
    )
      throw new Error("Command was not discovered by PI");
    await this.pi.request(
      {
        type: "prompt",
        message: `/${name}${args ? " " + args : ""}`,
        streamingBehavior: mode,
      },
      { timeoutMs: 0 },
    );
  }
}
