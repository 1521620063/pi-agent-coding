import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  assertWorkspace,
  PiNotFoundError,
  resolvePiLaunch,
  type LaunchConfig,
} from "./launcher";
import {
  createRpcTransport,
  type RequestOptions,
  type RpcTransport,
} from "./transport";
import type { ExtensionUiResponse, PiRecord, RpcCommand } from "./protocol";
import { modelPresentation } from "./protocol";
import type { SessionStore } from "../state/session-store";
import type { Unsubscribe } from "../shared/bridge";
interface ControllerConfig extends LaunchConfig {
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  trusted?: boolean;
  remote?: boolean;
}
export class PiController {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: RpcTransport;
  private listeners = new Set<(record: PiRecord) => void>();
  private connecting?: Promise<void>;
  private closing = false;
  private closePromise?: Promise<void>;
  private diagnostics = "";
  private generation = 0;
  private versionChild?: ChildProcessWithoutNullStreams;
  version?: string;
  constructor(
    private store: SessionStore,
    private config: ControllerConfig,
    private log: (text: string) => void = () => {},
  ) {}
  get pid() {
    return this.child?.pid;
  }
  configure(config: ControllerConfig) {
    this.config = { ...this.config, ...config };
  }
  onRecord(listener: (record: PiRecord) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  connect(workspaceUri: string): Promise<void> {
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    this.connecting = this.start(workspaceUri, generation).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async start(workspaceUri: string, generation: number) {
    await this.closeProcess();
    const check = () => {
      if (generation !== this.generation)
        throw new Error("PI connection cancelled");
    };
    check();
    this.store.update({ connection: "connecting", error: undefined });
    this.diagnostics = "";
    try {
      const cwd = assertWorkspace({
        trusted: this.config.trusted !== false,
        uri: workspaceUri,
        remote: this.config.remote,
      });
      const launch = await resolvePiLaunch(this.config, { ...process.env });
      check();
      this.version = await new Promise<string>((resolve, reject) => {
        const child = spawn(launch.command, [...launch.args, "--version"], {
          env: launch.env,
          cwd,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.versionChild = child;
        let output = "";
        const timer = setTimeout(() => {
          void killTree(child);
          reject(new Error("PI version check timed out"));
        }, this.config.startupTimeoutMs ?? 60000);
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          this.diagnostics = (this.diagnostics + chunk.toString()).slice(
            -16000,
          );
          this.log(chunk.toString());
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", (code) => {
          if (this.versionChild === child) this.versionChild = undefined;
          clearTimeout(timer);
          code === 0
            ? resolve(output.trim())
            : reject(new Error(`PI version check exited ${code}`));
        });
        child.stdin.end();
      });
      check();
      const child = spawn(launch.command, [...launch.args, "--mode", "rpc"], {
        env: launch.env,
        cwd,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.closing = false;
      child.stderr.on("data", (chunk: Buffer) => {
        const message = chunk.toString();
        this.diagnostics = (this.diagnostics + message).slice(-12000);
        this.log(message);
      });
      let failure: Error | undefined;
      const fail = (error: Error) => {
        if (this.child !== child || this.closing) return;
        failure = error;
        this.rpc?.dispose();
        this.store.update({
          connection: "error",
          run: "idle",
          error: `${error.message}\n${this.diagnostics}`.trim(),
        });
        void this.closeProcess(false);
      };
      child.on("error", fail);
      child.on("exit", (code, signal) =>
        fail(
          new Error(
            `PI exited (${code ?? signal}). Reconnect explicitly; prompts will not be replayed.`,
          ),
        ),
      );
      this.rpc = createRpcTransport(child, fail);
      this.rpc.onRecord((record) => {
        this.store.apply(record);
        for (const listener of this.listeners) listener(record);
      });
      const state = await this.request(
        { type: "get_state" },
        { timeoutMs: this.config.startupTimeoutMs ?? 60000 },
      );
      check();
      // A response and a fatal event can be delivered in the same stdout chunk.
      // The response promise is already resolved, so cancellation alone cannot
      // stop its continuation from publishing a dead process as connected.
      if (failure) throw failure;
      this.store.update({
        connection: "connected",
        workspace: fileURLToPath(workspaceUri),
        error: undefined,
      });
      this.syncState(state);
    } catch (error) {
      const message =
        `${error instanceof Error ? error.message : String(error)}\n${this.diagnostics}`.trim();
      await this.closeProcess();
      if (generation === this.generation)
        this.store.update({ connection: "error", error: message });
      if (generation === this.generation && error instanceof PiNotFoundError)
        throw error;
      throw new Error(message);
    }
  }
  syncState(state: any): void {
    if (!state || typeof state.sessionId !== "string")
      throw new Error("PI get_state returned incompatible data");
    this.store.update({
      session: {
        id: state.sessionId,
        path: state.sessionFile,
        name: state.sessionName,
      },
      model: modelPresentation(state.model),
      thinkingLevel: state.thinkingLevel,
      run: state.isStreaming ? "running" : "idle",
      compaction: {
        ...this.store.getSnapshot().compaction,
        active: !!state.isCompacting,
        enabled: state.autoCompactionEnabled,
      },
    });
  }
  request<T = any>(
    command: RpcCommand,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!this.rpc) return Promise.reject(new Error("PI is disconnected"));
    return this.rpc.request<T>(command, {
      timeoutMs: this.config.requestTimeoutMs ?? 10000,
      ...options,
    });
  }
  respond(record: ExtensionUiResponse) {
    return this.rpc
      ? this.rpc.send(record)
      : Promise.reject(new Error("PI is disconnected"));
  }
  async stopAll(): Promise<void> {
    await this.request({ type: "clear_queue" });
    await this.request({ type: "abort" });
  }
  async disconnect(): Promise<void> {
    ++this.generation;
    if (this.versionChild) await killTree(this.versionChild);
    this.versionChild = undefined;
    await this.closeProcess();
    this.store.update({ connection: "disconnected" });
  }
  private closeProcess(updateStatus = true): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose(updateStatus).finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }
  private async performClose(updateStatus: boolean): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.rpc?.dispose();
    this.rpc = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => []);
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clean = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            this.config.shutdownTimeoutMs ?? 5000,
          );
        }),
      ]);
      clearTimeout(timer);
      if (!clean) {
        await killTree(child);
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
    }
    this.child = undefined;
    this.store.update({
      ...(updateStatus ? { connection: "disconnected" as const } : {}),
      run: "idle",
      pendingUi: [],
      queues: { steering: [], followUp: [] },
      retry: {},
      compaction: {},
      statuses: {},
      widgets: {},
      title: undefined,
    });
    this.closing = false;
  }
}
async function killTree(child: {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}) {
  if (!child.pid) return;
  if (process.platform === "win32")
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      );
      killer.on("error", () => resolve());
      killer.on("exit", () => resolve());
    });
  else {
    try {
      // Each PI process owns a separate POSIX group; never signal the editor's group.
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
