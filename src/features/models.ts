import type { PiController } from "../pi/controller";
import type { Model, ThinkingLevel } from "../pi/protocol";
import { modelPresentation } from "../pi/protocol";
import type { SessionStore } from "../state/session-store";
export class ModelService {
  constructor(
    private pi: Pick<PiController, "request">,
    private store: SessionStore,
  ) {}
  async refresh(): Promise<void> {
    const [models, thinking] = await Promise.all([
      this.pi.request<{ models: Model[] }>({ type: "get_available_models" }),
      this.pi.request<{ levels: ThinkingLevel[] }>({
        type: "get_available_thinking_levels",
      }),
    ]);
    if (!Array.isArray(models.models) || !Array.isArray(thinking.levels))
      throw new Error("Incompatible PI model response");
    this.store.update({
      models: models.models
        .map(modelPresentation)
        .filter((model): model is Model => !!model),
      thinkingLevels: thinking.levels,
    });
  }
  async select(provider: string, modelId: string): Promise<void> {
    const model = await this.pi.request<Model>({
      type: "set_model",
      provider,
      modelId,
    });
    this.store.update({ model: modelPresentation(model) });
    await this.refresh();
    const state = await this.pi.request({ type: "get_state" });
    if (state.thinkingLevel)
      this.store.update({ thinkingLevel: state.thinkingLevel });
  }
  async setThinking(level: ThinkingLevel): Promise<void> {
    if (!this.store.getSnapshot().thinkingLevels.includes(level))
      throw new Error("Unavailable thinking level");
    await this.pi.request({ type: "set_thinking_level", level });
    this.store.update({ thinkingLevel: level });
  }
}
