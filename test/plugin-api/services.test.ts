import {
  CAPABILITIES,
  definePlugin,
  FLAG_CAPABILITIES,
  LANGUAGE_CAPABILITIES,
  PLUGIN_LANGUAGES,
  serviceProblems,
  SESSION_CAPABILITIES,
  z,
  type Capability,
  type CommandLanguage,
  type LanguageServices,
  type LeaseManager,
  type PluginSession,
  type SessionBase,
  type SqlLanguage,
} from "@table-craft/plugin-api";
import { describe, expect, expectTypeOf, it } from "vitest";

const SERVICE = {};
const SESSION_BASE: SessionBase = {
  execute: () => Promise.reject(new Error("not run")),
  close: () => Promise.resolve(),
  serverVersion: "test",
};
/** Only `services` is read; the rest of a language is the contract suite's to check. */
function language(services: Partial<Record<keyof LanguageServices, object>> = {}): SqlLanguage {
  return { services } as unknown as SqlLanguage;
}
const LANGUAGE = language();
const COMMAND_LANGUAGE = {} as CommandLanguage;
const PATH_SCHEMA = z.strictObject({ path: z.string() });

function messages(...args: Parameters<typeof serviceProblems>): string[] {
  return serviceProblems(...args).map((problem) => problem.message);
}

describe("serviceProblems", () => {
  it("givenSessionWithExactlyDeclaredServices_whenChecked_thenNoProblem", () => {
    const session = { services: { schemaTree: SERVICE, transactions: SERVICE } };

    expect(serviceProblems(["sql", "schemaTree", "transactions"], { language: LANGUAGE }, session)).toEqual([]);
  });

  it("givenDeclaredCapabilityWithoutService_whenChecked_thenMissingNamesCapability", () => {
    const session = { services: { keyValue: SERVICE } };

    expect(serviceProblems(["commands", "keyValue", "leases"], { commandLanguage: COMMAND_LANGUAGE }, session)).toEqual(
      [
        {
          kind: "missing",
          capability: "leases",
          where: "session",
          message: "declares leases but its session has no leases service",
        },
      ],
    );
  });

  it("givenServiceWithoutCapability_whenChecked_thenUndeclared", () => {
    const session = { services: { schemaTree: SERVICE, nodes: SERVICE } };

    expect(messages(["sql", "schemaTree"], { language: LANGUAGE }, session)).toEqual([
      "has a nodes service on its session but does not declare nodes",
    ]);
  });

  it("givenLanguageServiceWithoutCapability_whenChecked_thenUndeclaredOnLanguage", () => {
    const problems = serviceProblems(["sql"], { language: language({ objects: SERVICE }) });

    expect(problems).toEqual([
      {
        kind: "undeclared",
        capability: "objects",
        where: "language",
        message: "has a objects service on its language but does not declare objects",
      },
    ]);
  });

  it("givenSqlWithoutLanguage_whenChecked_thenMissingOnPlugin", () => {
    expect(serviceProblems(["sql"], {})).toEqual([
      { kind: "missing", capability: "sql", where: "plugin", message: "declares sql but has no a SQL language" },
    ]);
  });

  it("givenFlagCapability_whenChecked_thenNoServiceExpected", () => {
    const session = { services: { explain: SERVICE, keyValue: SERVICE } };
    const plugin = { language: language({ explain: SERVICE }), commandLanguage: COMMAND_LANGUAGE };

    expect(messages(["sql", "explain", "keyValue", ...FLAG_CAPABILITIES], plugin, session)).toEqual([
      "has a command language but does not declare commands",
    ]);
  });
});

describe("capability classification", () => {
  it("givenEveryCapability_whenClassified_thenSessionLanguagePluginOrFlagExactlyOnce", () => {
    const plugin = Object.keys(PLUGIN_LANGUAGES) as Capability[];
    const flags: readonly Capability[] = FLAG_CAPABILITIES;
    const classified = new Set<Capability>([...SESSION_CAPABILITIES, ...LANGUAGE_CAPABILITIES, ...plugin, ...flags]);
    const kinds = (capability: Capability): number =>
      [
        SESSION_CAPABILITIES.some((name) => name === capability) ||
          LANGUAGE_CAPABILITIES.some((name) => name === capability),
        plugin.includes(capability),
        flags.includes(capability),
      ].filter(Boolean).length;

    expect([...classified].sort()).toEqual([...CAPABILITIES].sort());
    expect(CAPABILITIES.filter((capability) => kinds(capability) !== 1)).toEqual([]);
  });
});

describe("definePlugin", () => {
  it("givenDefinePluginDeclaringLeases_whenSessionLacksLeases_thenTypeError", () => {
    const withoutLeases = { ...SESSION_BASE, services: {} };
    const withLeases = { ...SESSION_BASE, services: { leases: {} as LeaseManager } };

    definePlugin({
      id: "leases",
      capabilities: ["leases"],
      connectionSchema: PATH_SCHEMA,
      // @ts-expect-error a session without leases breaks the declared capability
      connect: () => Promise.resolve(withoutLeases),
    });
    const plugin = definePlugin({
      id: "leases",
      capabilities: ["leases"],
      connectionSchema: PATH_SCHEMA,
      connect: () => Promise.resolve(withLeases),
    });

    expectTypeOf(withoutLeases).not.toExtend<PluginSession<"leases">>();
    expectTypeOf(plugin).toHaveProperty("connect").returns.toEqualTypeOf<Promise<PluginSession<"leases">>>();
  });

  it("givenDefinePluginWithSchema_whenConnectCalled_thenConfigIsSchemaType", () => {
    const plugin = definePlugin({
      id: "file",
      capabilities: [],
      connectionSchema: PATH_SCHEMA,
      connect: () => Promise.resolve({ ...SESSION_BASE, services: {} }),
    });

    expectTypeOf(plugin).toHaveProperty("connect").parameter(0).toEqualTypeOf<{ path: string }>();
  });
});
