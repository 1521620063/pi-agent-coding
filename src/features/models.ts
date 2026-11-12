import type { PiController } from "../pi/controller";
import type { Model, ThinkingLevel } from "../pi/protocol";
import { modelPresentation } from "../pi/protocol";
import type { SessionStore } from "../state/session-store";
export class ModelService {
  private sequence = 0;
  constructor(
    private pi: Pick<PiController, "request">,
    private store: SessionStore,
  ) {}
  async refresh(): Promise<void> {
    const sequence = ++this.sequence;
    const revision = this.store.sessionRevision;
    const [models, thinking] = await Promise.all([
      this.pi.request<{ models: Model[] }>({ type: "get_available_models" }),
      this.pi.request<{ levels: ThinkingLevel[] }>({
        type: "get_available_thinking_levels",
      }),
    ]);
    if (sequence !== this.sequence || revision !== this.store.sessionRevision)
      return;
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
    const revision = this.store.sessionRevision;
    const model = await this.pi.request<Model>({
      type: "set_model",
      provider,
      modelId,
    });
    if (revision !== this.store.sessionRevision) return;
    this.store.update({ model: modelPresentation(model) });
    await this.refresh();
    if (revision !== this.store.sessionRevision) return;
    const state = await this.pi.request({ type: "get_state" });
    if (revision !== this.store.sessionRevision) return;
    if (state.thinkingLevel)
      this.store.update({ thinkingLevel: state.thinkingLevel });
  }
  async setThinking(level: ThinkingLevel): Promise<void> {
    const revision = this.store.sessionRevision;
    if (!this.store.getSnapshot().thinkingLevels.includes(level))
      throw new Error("Unavailable thinking level");
    await this.pi.request({ type: "set_thinking_level", level });
    if (revision !== this.store.sessionRevision) return;
    this.store.update({ thinkingLevel: level });
  }
  async cycleModel(): Promise<void> {
    const revision = this.store.sessionRevision;
    const result = await this.pi.request({ type: "cycle_model" });
    if (this.store.sessionRevision !== revision) return;
    if (result)
      this.store.update({
        model: modelPresentation(result.model),
        thinkingLevel: result.thinkingLevel,
      });
    await this.refresh();
  }
  async cycleThinking(): Promise<void> {
    const revision = this.store.sessionRevision;
    const result = await this.pi.request({ type: "cycle_thinking_level" });
    if (this.store.sessionRevision !== revision) return;
    if (
      result &&
      this.store.getSnapshot().thinkingLevels.includes(result.level)
    )
      this.store.update({ thinkingLevel: result.level });
  }
}
