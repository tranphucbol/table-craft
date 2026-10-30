import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type * as api from "@table-craft/plugin-api";
import type * as wire from "@table-craft/desktop/engine/protocol.js";
import { COMMAND_ADMIT_MAX_COMMANDS, COMMAND_ADMIT_MAX_TEXT } from "@table-craft/desktop/engine/protocol.js";
import {
  admitCommands,
  assertExecutable,
  assertScriptable,
  NOT_ADMITTED_MESSAGE,
} from "@table-craft/desktop/engine/admission.js";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { scriptRoutes } from "@table-craft/desktop/engine/routes/script.js";
import { statementRoutes } from "@table-craft/desktop/engine/routes/statement.js";
import { engineRequestSchema } from "@table-craft/desktop/engine/requests.js";
import { EngineFailure } from "@table-craft/desktop/engine/failures.js";
import etcd from "@table-craft/plugin-etcd";

const SECRET = "hunter2";

function language(admit?: api.CommandLanguage["admit"]): api.CommandLanguage {
  return {
    split: (text) => [{ from: 0, to: text.length, sql: text }],
    classify: () => ({ kind: "other", destructive: null }),
    complete: () => Promise.reject(new Error("Admission never completes.")),
    ...(admit === undefined ? {} : { admit }),
  };
}

function refusalOf(work: () => void): EngineFailure {
  try {
    work();
  } catch (cause) {
    if (cause instanceof EngineFailure) return cause;
    throw cause;
  }
  throw new Error("expected a refusal");
}

describe("commands.admit", () => {
  it("givenOptionalAdmit_whenOldPluginUsed_thenNotRequired", () => {
    expectTypeOf<Record<never, never>>().toExtend<Pick<api.CommandLanguage, "admit">>();
    expectTypeOf<wire.CommandIntentArguments>().toEqualTypeOf<api.CommandIntentArguments>();
    expectTypeOf<wire.CommandIntent>().toEqualTypeOf<api.CommandIntent>();
    expectTypeOf<wire.CommandAdmissionVerdict>().toEqualTypeOf<api.CommandAdmissionVerdict>();
  });

  it("givenRequest_whenParsed_thenStrictAndBounded", () => {
    expect(engineRequestSchema.safeParse({ id: 1, type: "commands.admit", commands: ["get a"] }).success).toBe(true);
    expect(engineRequestSchema.safeParse({ id: 1, type: "commands.admit", commands: [] }).success).toBe(true);
    expect(
      engineRequestSchema.safeParse({ id: 1, type: "commands.admit", commands: ["get a"], sessionId: "s" }).success,
    ).toBe(false);
    expect(engineRequestSchema.safeParse({ id: 1, type: "commands.admit", commands: "get a" }).success).toBe(false);
    expect(engineRequestSchema.safeParse({ id: 1, type: "commands.admit", commands: [1] }).success).toBe(false);
    const tooMany = Array.from({ length: COMMAND_ADMIT_MAX_COMMANDS + 1 }, () => "get a");
    expect(engineRequestSchema.safeParse({ id: 1, type: "commands.admit", commands: tooMany }).success).toBe(false);
    const tooLong = "x".repeat(COMMAND_ADMIT_MAX_TEXT + 1);
    expect(engineRequestSchema.safeParse({ id: 1, type: "commands.admit", commands: [tooLong] }).success).toBe(false);
  });

  it("givenPluginWithoutAdmit_whenAdmitted_thenEveryCommandExecutes", () => {
    expect(admitCommands(language(), ["a", "b"])).toEqual([
      { admit: "execute", safeLabel: "" },
      { admit: "execute", safeLabel: "" },
    ]);
    expect(admitCommands(null, ["SELECT 1"])).toEqual([{ admit: "execute", safeLabel: "" }]);
  });

  it("givenThrowingAdmit_whenAdmitted_thenRejectedWithoutItsMessage", () => {
    const admit = vi.fn((command: string): api.CommandAdmission => {
      throw new Error(`bad ${command}`);
    });

    const answers = admitCommands(language(admit), [`user add alice ${SECRET}`]);

    expect(answers).toEqual([{ admit: "reject", safeLabel: "" }]);
    expect(JSON.stringify(answers)).not.toContain(SECRET);
  });

  it.each([
    { admit: "maybe", safeLabel: "" },
    { admit: "execute" },
    { admit: "execute", safeLabel: "x".repeat(65) },
    { admit: "execute", safeLabel: "", extra: SECRET },
    { admit: "managed", intent: "watch", safeLabel: "watch" },
    { admit: "managed", intent: "nuke", arguments: { kind: "none" }, safeLabel: "nuke" },
    { admit: "managed", intent: "credentials", arguments: { kind: "none" }, safeLabel: "user add" },
    {
      admit: "managed",
      intent: "access",
      arguments: { kind: "credentials", change: "createUser", user: "a" },
      safeLabel: "",
    },
    {
      admit: "managed",
      intent: "credentials",
      arguments: { kind: "credentials", change: "createUser", user: "a", password: SECRET },
      safeLabel: "user add",
    },
    { admit: "managed", intent: "leaseRevoke", arguments: { kind: "leaseRevoke", leaseId: "0" }, safeLabel: "" },
    { admit: "reject", safeLabel: SECRET },
    null,
  ])("givenAnswerOutsideTheContract_whenAdmitted_thenRejected %#", (answer) => {
    const answers = admitCommands(
      language(() => answer as unknown as api.CommandAdmission),
      ["cmd"],
    );

    expect(answers).toEqual([{ admit: "reject", safeLabel: "" }]);
  });

  it("givenEtcd_whenConsoleTextAdmitted_thenCredentialsNeverExecute", () => {
    const answers = admitCommands(etcd.commandLanguage ?? null, [
      "get /a",
      `user add alice ${SECRET}`,
      "user passwd alice",
      "watch /app --prefix",
    ]);

    expect(answers.map((answer) => answer.admit)).toEqual(["execute", "reject", "managed", "managed"]);
    expect(JSON.stringify(answers)).not.toContain(SECRET);
  });

  it("givenNotAdmitted_whenExecuteReached_thenRefusedWithFixedText", () => {
    const refusal = refusalOf(() => assertExecutable(etcd.commandLanguage ?? null, `user add alice:${SECRET}`));

    expect(refusal.error.message).toBe(NOT_ADMITTED_MESSAGE);
    expect(JSON.stringify(refusal.error)).not.toContain(SECRET);
    expect(() => assertExecutable(etcd.commandLanguage ?? null, "watch /app")).toThrow(EngineFailure);
    expect(() => assertExecutable(etcd.commandLanguage ?? null, "get /app")).not.toThrow();
    expect(() => assertExecutable(null, "SELECT 1")).not.toThrow();
  });

  it("givenLeaseGrant_whenAdmitted_thenLeasesIntentWithoutArguments", () => {
    expect(admitCommands(etcd.commandLanguage ?? null, ["lease grant 60"])).toEqual([
      { admit: "managed", intent: "leaseGrant", arguments: { kind: "none" }, safeLabel: "lease grant" },
    ]);
  });
});

describe("engine-side runs of console text", () => {
  function connection(commandLanguage: api.CommandLanguage | null) {
    const runScript = vi.fn(() => Promise.resolve({}));
    const explainStatement = vi.fn(() => Promise.resolve({}));
    const runStatement = vi.fn(() => Promise.resolve({}));
    const context = {
      commandLanguage: () => commandLanguage,
      runScript,
      explainStatement,
      runStatement,
      sessionFor: vi.fn(),
      splitScript: vi.fn(),
      scripts: {},
      scriptTaskOf: vi.fn(),
    } as unknown as ConnectionContext;
    return { context, runScript, explainStatement, runStatement };
  }

  async function refusalOfAsync(work: () => Promise<unknown>): Promise<EngineFailure> {
    try {
      await work();
    } catch (cause) {
      if (cause instanceof EngineFailure) return cause;
      throw cause;
    }
    throw new Error("expected a refusal");
  }

  const SCRIPT = { id: 1, type: "script.run", files: ["/tmp/creds.etcd"], namespace: null, onError: "stop" } as const;

  it("givenAdmittingPlugin_whenScriptRun_thenRefusedBeforeAnyFileIsRead", async () => {
    const { context, runScript } = connection(etcd.commandLanguage ?? null);

    const refusal = await refusalOfAsync(() => scriptRoutes(context)["script.run"](SCRIPT));

    expect(runScript).not.toHaveBeenCalled();
    expect(refusal.error.message).toBe(NOT_ADMITTED_MESSAGE);
    expect(() => assertScriptable(etcd.commandLanguage ?? null)).toThrow(EngineFailure);
  });

  it("givenPluginWithoutAdmit_whenScriptRun_thenRunsAsBefore", async () => {
    for (const commands of [null, language()]) {
      const { context, runScript } = connection(commands);

      await scriptRoutes(context)["script.run"](SCRIPT);

      expect(runScript).toHaveBeenCalledWith(SCRIPT);
    }
  });

  it.each([`user add alice ${SECRET}`, `user add alice:${SECRET}`, "watch /app"])(
    "givenNotAdmitted_whenExplained_thenRefusedWithFixedTextAndNothingSent %#",
    async (sql) => {
      const { context, explainStatement } = connection(etcd.commandLanguage ?? null);

      const refusal = await refusalOfAsync(() =>
        statementRoutes(context)["statement.explain"]({
          id: 1,
          type: "statement.explain",
          sessionId: "s",
          sql,
          analyze: false,
        }),
      );

      expect(explainStatement).not.toHaveBeenCalled();
      expect(refusal.error.message).toBe(NOT_ADMITTED_MESSAGE);
      expect(JSON.stringify(refusal.error)).not.toContain(SECRET);
    },
  );

  it("givenNotAdmitted_whenExecuteRouteReached_thenNothingRuns", async () => {
    const { context, runStatement } = connection(etcd.commandLanguage ?? null);

    const refusal = await refusalOfAsync(() =>
      statementRoutes(context)["statement.execute"]({
        id: 1,
        type: "statement.execute",
        sessionId: "s",
        sql: `user add alice ${SECRET}`,
        pageRows: 1,
        fetchAllCap: 1,
      }),
    );

    expect(runStatement).not.toHaveBeenCalled();
    expect(JSON.stringify(refusal.error)).not.toContain(SECRET);
  });
});
