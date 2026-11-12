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
      commands: result.commands
        .filter(
          (command) =>
            typeof command.name === "string" &&
            ["skill", "prompt", "extension"].includes(command.source),
        )
        .map((command) => {
          const sourceInfo: NonNullable<SlashCommand["sourceInfo"]> = {};
          for (const key of ["path", "scope", "origin", "baseDir"] as const) {
            const value = command.sourceInfo?.[key];
            if (
              typeof value === "string" &&
              value.length <= 32768 &&
              !/[\u0000-\u001f]/.test(value)
            )
              sourceInfo[key] = value;
          }
          return {
            name: command.name,
            source: command.source,
            ...(typeof command.description === "string"
              ? { description: command.description }
              : {}),
            ...(Object.keys(sourceInfo).length ? { sourceInfo } : {}),
          };
        }),
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
