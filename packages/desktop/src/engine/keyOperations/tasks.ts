import type { Capability, Session } from "@table-craft/plugin-api";
import type { KeyTask, KeyTaskKind } from "@table-craft/desktop/engine/protocol.js";
import { type KeyOperationScope, invalidOperation } from "./scope.js";

const RETAINED_TASKS = 64;
const RUNNING_TASKS = 8;

export interface KeyJob {
  readonly signal: AbortSignal;
  readonly session: Session;
  check(): void;
  progress(completed: string, total: string | null): void;
  beginWrite(): void;
  confirmed(): void;
  hashes(hashes: NonNullable<KeyTask["hashes"]>): void;
}

export type KeyLocalJob = Omit<KeyJob, "session">;
type JobRun =
  | { readonly kind: "session"; readonly run: (job: KeyJob) => Promise<void> }
  | { readonly kind: "local"; readonly run: (job: KeyLocalJob) => Promise<void> };
type TaskFamily = "maintenance" | "transfer" | "watch";

function familyOf(kind: KeyTaskKind): TaskFamily {
  if (kind === "watchExport") return "watch";
  return kind === "import" || kind === "export" ? "transfer" : "maintenance";
}

function familyCapability(family: TaskFamily): Capability {
  return family === "watch" ? "watch" : family === "maintenance" ? "maintenance" : "bulkTransfer";
}

interface TaskEntry {
  task: KeyTask;
  readonly capability: Capability;
  readonly write: boolean;
  readonly run: JobRun;
  readonly resume: (() => (job: KeyJob) => Promise<void>) | undefined;
  controller: AbortController;
  session: Session | null;
  writing: boolean;
  settling: boolean;
  work: Promise<void>;
}

export class KeyTasks {
  private readonly entries = new Map<string, TaskEntry>();
  constructor(private readonly scope: KeyOperationScope) {
    scope.register(() => this.close());
  }

  start(
    kind: KeyTaskKind,
    capability: Capability,
    write: boolean,
    run: (job: KeyJob) => Promise<void>,
    resume?: () => (job: KeyJob) => Promise<void>,
  ): KeyTask {
    return this.create(kind, capability, write, { kind: "session", run }, resume);
  }

  startLocal(kind: KeyTaskKind, capability: Capability, run: (job: KeyLocalJob) => Promise<void>): KeyTask {
    return this.create(kind, capability, false, { kind: "local", run });
  }

  private create(
    kind: KeyTaskKind,
    capability: Capability,
    write: boolean,
    run: JobRun,
    resume?: () => (job: KeyJob) => Promise<void>,
  ): KeyTask {
    this.scope.capability(capability);
    if (write) this.scope.writable();
    if ([...this.entries.values()].filter((entry) => entry.task.state === "running").length >= RUNNING_TASKS)
      throw invalidOperation("Too many running tasks; wait for one to finish.");
    while (this.entries.size >= RETAINED_TASKS) {
      const oldest = [...this.entries].find(([, entry]) => entry.task.state !== "running");
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
    }
    const task: KeyTask = {
      taskId: this.scope.id(),
      kind,
      state: "running",
      completed: "0",
      total: null,
      error: null,
      outcome: "confirmed",
      resumable: false,
    };
    const entry: TaskEntry = {
      task,
      capability,
      write,
      run,
      resume,
      controller: new AbortController(),
      session: null,
      writing: false,
      settling: true,
      work: Promise.resolve(),
    };
    this.entries.set(task.taskId, entry);
    entry.work = this.execute(entry, run);
    return task;
  }

  private async execute(entry: TaskEntry, run: JobRun): Promise<void> {
    const check = () => {
      this.scope.live();
      if (entry.controller.signal.aborted) throw invalidOperation("Task cancelled.");
      if (entry.write) this.scope.writable();
    };
    try {
      check();
      const job: KeyLocalJob = {
        signal: entry.controller.signal,
        check,
        progress: (completed, total) => {
          check();
          entry.task = { ...entry.task, completed, total };
        },
        beginWrite: () => {
          check();
          entry.writing = true;
        },
        confirmed: () => {
          entry.writing = false;
        },
        hashes: (hashes) => {
          check();
          entry.task = { ...entry.task, hashes };
        },
      };
      if (run.kind === "session") {
        const session = await this.scope.open(entry.capability);
        entry.session = session;
        check();
        await run.run({ ...job, session });
      } else await run.run(job);
      check();
      entry.task = { ...entry.task, state: "completed", resumable: false };
    } catch {
      const uncertain = entry.writing;
      entry.task = {
        ...entry.task,
        state: entry.controller.signal.aborted ? "cancelled" : "failed",
        outcome: uncertain ? "uncertain" : "confirmed",
        error: uncertain
          ? "The operation may have committed. Inspect the cluster before taking further action; automatic replay is disabled."
          : "The task stopped. Review access, cluster health and file authorization before resuming.",
        resumable: !uncertain && entry.resume !== undefined,
      };
    } finally {
      const session = entry.session;
      entry.session = null;
      if (session !== null) await this.scope.release(session);
      entry.settling = false;
    }
  }

  list(family: TaskFamily): readonly KeyTask[] {
    this.scope.capability(familyCapability(family));
    return [...this.entries.values()].map((entry) => entry.task).filter((task) => familyOf(task.kind) === family);
  }

  async cancel(id: string, family: TaskFamily): Promise<void> {
    const entry = this.find(id, family);
    if (entry.task.state !== "running") return;
    entry.controller.abort();
    if (entry.session !== null) await this.scope.release(entry.session);
  }

  resume(id: string): KeyTask {
    const entry = this.find(id, "transfer");
    this.scope.writable();
    if (entry.settling || !entry.task.resumable || entry.task.outcome !== "confirmed" || entry.resume === undefined)
      throw invalidOperation("This task has no confirmed resumable boundary.");
    if ([...this.entries.values()].filter((held) => held.task.state === "running").length >= RUNNING_TASKS)
      throw invalidOperation("Too many running tasks.");
    entry.controller = new AbortController();
    entry.settling = true;
    entry.task = { ...entry.task, state: "running", error: null, resumable: false };
    entry.work = this.execute(entry, { kind: "session", run: entry.resume() });
    return entry.task;
  }

  private find(id: string, family: TaskFamily): TaskEntry {
    this.scope.capability(familyCapability(family));
    const entry = this.entries.get(id);
    if (entry === undefined || familyOf(entry.task.kind) !== family)
      throw invalidOperation("No task with this ID belongs to this connection and task family.");
    return entry;
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.work));
  }
  async close(): Promise<void> {
    for (const entry of this.entries.values()) entry.controller.abort();
    await Promise.allSettled(
      [...this.entries.values()].flatMap((entry) =>
        entry.session === null ? [] : [this.scope.release(entry.session)],
      ),
    );
    this.entries.clear();
  }
}
