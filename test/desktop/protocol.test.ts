import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FORMAT_STYLES as SETTINGS_FORMAT_STYLES,
  KEYWORD_CASES as SETTINGS_KEYWORD_CASES,
  type FormatSettings,
} from "@table-craft/desktop/settings/settings.js";
import {
  EXTRACTOR_KINDS,
  HISTORY_OUTCOMES,
  HISTORY_SOURCES,
  IMPORT_ENCODINGS,
  IMPORT_FAILURE_REASONS,
  RESULT_FETCH_ALL_CAP,
  RESULT_PAGE_ROWS,
  RESULT_WINDOW_ROWS,
  SSH_AUTH_METHODS,
  type CachedCatalog,
  type CellInput,
  type CoreErrorCode,
  type EditableIdentity,
  type ExtractorKind,
  type FilterChip,
  type FindQuery,
  type FoundMatch,
  type HistoryEntry,
  type HistoryStatement,
  type HostKeyOffer,
  type SshAuthMethod,
  type SshEndpoint,
  type SshHop,
  type ImportErrorPolicy as CoreImportErrorPolicy,
  type ImportFormat as CoreImportFormat,
  type ImportTransaction as CoreImportTransaction,
  type OrderTerm,
  type ResultState,
  type ResultSummary,
  type ResultWindow,
  type RowEdit,
  type SortKey,
  type SubmittedEdits,
  type TypeClass,
  type ViewSpec,
  type ViewState,
} from "@table-craft/core";
import {
  CAPABILITIES,
  NODE_ALL_PRIMARIES,
  NODE_AUTO,
  type CommandReply,
  COMPLETION_KINDS,
  IMPORT_KINDS,
  INSPECTION_IDS,
  PROBLEM_SEVERITIES,
  MANIFEST_FILE,
  OBJECT_KINDS,
  type CatalogObject,
  type DdlScript,
  type ObjectChange,
  type ObjectFeatures,
  type ObjectKind,
  type TableDesign,
  type ImportKind,
  type Capability,
  type Column,
  type ColumnMeta,
  type CompletionItem,
  type CompletionResult,
  type CompletionScope,
  type Declaration,
  type InspectionId,
  type Problem,
  type ProblemSeverity,
  type QuickFix,
  type TextEdit,
  type Explainability,
  type ExplainedPlan,
  type Namespace,
  type NamespaceCatalog,
  type PlanNode,
  type PlanProperty,
  type FormatOptions,
  FORMAT_STYLES,
  KEYWORD_CASES,
  type ParameterValue,
  type PluginErrorCode,
  type ServerSession,
  type ServerSessionState,
  type SessionTarget,
  NODE_ROLES,
  KEY_TYPES,
  type KeyBytes,
  type KeyDatabase,
  type KeySource,
  type KeyApplied,
  type KeyApplyOptions,
  type KeyChange,
  type KeyDetails,
  type KeyExpiry,
  type KeyInfo,
  type KeyConflictSnapshot,
  type KeyHistoryRequest,
  type KeyHistoryPage,
  type KeyHistoryEvent,
  type KeyHistoryGap,
  type KeyRevision,
  type KeyspaceFeatures,
  type KeyScan,
  type ServerInfo,
  type ServerNode,
  type SlowCommand,
  type SqlParameter,
  type StatementClass,
  type StatementSpan,
  type TransactionMode,
  type WireValue,
  type ConnectionUrlSpec,
  type NetworkSpec,
  type ParsedConnectionUrl,
  type Brand,
  type CancelReach,
  type ServerTimeout,
  type Session,
} from "@table-craft/plugin-api";
import * as protocol from "@table-craft/desktop/engine/protocol.js";
import * as bridge from "@table-craft/desktop/preload/bridge.js";

describe("engine protocol", () => {
  it("givenKeyHistoryTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.KeyConflictSnapshot>().toEqualTypeOf<KeyConflictSnapshot>();
    expectTypeOf<protocol.KeyHistoryRequest>().toEqualTypeOf<KeyHistoryRequest>();
    expectTypeOf<protocol.KeyHistoryPage>().toEqualTypeOf<KeyHistoryPage>();
    expectTypeOf<protocol.KeyHistoryEvent>().toEqualTypeOf<KeyHistoryEvent>();
    expectTypeOf<protocol.KeyHistoryGap>().toEqualTypeOf<KeyHistoryGap>();
    expectTypeOf<protocol.KeyRevision>().toEqualTypeOf<KeyRevision>();
    expectTypeOf<protocol.KeyspaceFeatures>().toEqualTypeOf<KeyspaceFeatures>();
  });
  it("givenProtocolConstants_whenComparedWithCore_thenEqual", () => {
    expect(protocol.RESULT_WINDOW_ROWS).toBe(RESULT_WINDOW_ROWS);
    expect(protocol.RESULT_PAGE_ROWS).toBe(RESULT_PAGE_ROWS);
    expect(protocol.RESULT_FETCH_ALL_CAP).toBe(RESULT_FETCH_ALL_CAP);
  });

  it("givenConnectionUrlTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<bridge.ConnectionUrlSpec>().toEqualTypeOf<ConnectionUrlSpec>();
    expectTypeOf<bridge.ParsedUrl>().toEqualTypeOf<ParsedConnectionUrl>();
  });

  it("givenBrandTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<bridge.Brand>().toEqualTypeOf<Readonly<Brand>>();
    expectTypeOf<bridge.PluginInfo["brands"]>().toEqualTypeOf<readonly Readonly<Brand>[]>();
    expectTypeOf<protocol.OpenedSession["serverBrand"]>().toEqualTypeOf<NonNullable<Session["serverBrand"]> | null>();
    expectTypeOf<Extract<protocol.ProbeResult, { ok: true }>["serverBrand"]>().toEqualTypeOf<string | null>();
  });

  it("givenTimeoutTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.ServerTimeout>().toEqualTypeOf<Readonly<ServerTimeout>>();
    expectTypeOf<protocol.CancelReach>().toEqualTypeOf<Readonly<CancelReach>>();
    expectTypeOf<protocol.OpenedSession["cancelReach"]>().toEqualTypeOf<Readonly<CancelReach> | null>();
    expectTypeOf<
      Extract<protocol.ProbeResult, { ok: true }>["cancelReach"]
    >().toEqualTypeOf<Readonly<CancelReach> | null>();
    expectTypeOf<bridge.LastServer["cancel"]>().toEqualTypeOf<Readonly<CancelReach> | undefined>();
  });

  it("givenSshTypes_whenComparedWithCoreAndPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.SshAuthMethod>().toEqualTypeOf<SshAuthMethod>();
    expectTypeOf<protocol.SshTunnelConfig>().toEqualTypeOf<SshEndpoint>();
    expectTypeOf<protocol.HostKeyOffer>().toEqualTypeOf<HostKeyOffer>();
    expectTypeOf<protocol.SshHop>().toEqualTypeOf<SshHop>();
    expectTypeOf<NonNullable<bridge.PluginInfo["network"]>>().toEqualTypeOf<Readonly<NetworkSpec>>();
    expect(Object.values(bridge.SSH_SECRET_KEYS).every((key) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key))).toBe(true);
    expect(SSH_AUTH_METHODS).toEqual(["password", "key", "agent"]);
  });

  it("givenHistoryTypes_whenComparedWithCore_thenIdentical", () => {
    expectTypeOf<bridge.HistoryEntry>().toEqualTypeOf<HistoryEntry>();
    expectTypeOf<bridge.HistoryStatement>().toEqualTypeOf<HistoryStatement>();
    expect(bridge.HISTORY_OUTCOMES).toEqual(HISTORY_OUTCOMES);
    expect(bridge.HISTORY_SOURCES).toEqual(HISTORY_SOURCES);
  });

  it("givenResultTypes_whenComparedWithCore_thenIdentical", () => {
    expectTypeOf<protocol.ResultState>().toEqualTypeOf<ResultState>();
    expectTypeOf<protocol.SortKey>().toEqualTypeOf<SortKey>();
    expectTypeOf<protocol.TypeClass>().toEqualTypeOf<TypeClass>();
    expectTypeOf<protocol.ExtractorKind>().toEqualTypeOf<ExtractorKind>();
    expect(protocol.EXTRACTOR_KINDS).toEqual(EXTRACTOR_KINDS);
  });

  it("givenViewTypes_whenComparedWithCore_thenIdentical", () => {
    expectTypeOf<protocol.FindQuery>().toEqualTypeOf<FindQuery>();
    expectTypeOf<protocol.FilterChip>().toEqualTypeOf<FilterChip>();
    expectTypeOf<protocol.ViewSpec>().toEqualTypeOf<ViewSpec>();
    expectTypeOf<protocol.ViewState>().toEqualTypeOf<ViewState>();
    expectTypeOf<protocol.FoundMatch>().toEqualTypeOf<FoundMatch>();
    expectTypeOf<protocol.ResultWindow>().toEqualTypeOf<ResultWindow>();
  });

  it("givenProtocolWireTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.WireValue>().toEqualTypeOf<WireValue>();
    expectTypeOf<protocol.Column>().toEqualTypeOf<Column>();
    expectTypeOf<protocol.Capability>().toEqualTypeOf<Capability>();
  });

  it("givenNewCapability_whenProtocolCompared_thenMatchesPluginApi", () => {
    expectTypeOf<protocol.Capability>().toEqualTypeOf<(typeof CAPABILITIES)[number]>();
    expect(CAPABILITIES).toContain("schemaTree");
  });

  it("givenCatalogTypes_whenComparedWithPluginApiAndCore_thenIdentical", () => {
    expectTypeOf<protocol.Namespace>().toEqualTypeOf<Namespace>();
    expectTypeOf<protocol.NamespaceCatalog>().toEqualTypeOf<NamespaceCatalog>();
    expectTypeOf<protocol.DescribedCatalog>().toEqualTypeOf<CachedCatalog>();
  });

  it("givenPluginErrorCodes_whenComparedWithEngineErrorCodes_thenEveryOneIsCovered", () => {
    expectTypeOf<PluginErrorCode>().toExtend<protocol.EngineErrorCode>();
  });

  it("givenExecutedStatement_whenComparedWithCoreSummary_thenCarriesEveryField", () => {
    expectTypeOf<
      Omit<
        protocol.ExecutedStatement,
        "firstWindow" | "transactionOpen" | "namespace" | "reconnected" | "reply" | "source"
      >
    >().toEqualTypeOf<ResultSummary>();
    expectTypeOf<NonNullable<protocol.ExecutedStatement["reply"]>>().toEqualTypeOf<CommandReply>();
    expect([protocol.NODE_AUTO, protocol.NODE_ALL_PRIMARIES]).toEqual([NODE_AUTO, NODE_ALL_PRIMARIES]);
  });

  it("givenScriptTypes_whenComparedWithPluginApi_thenIdentical", () => {
    // setsNamespace stays in the engine, which answers with the namespace itself (plan 022).
    type Classified = StatementSpan &
      Omit<StatementClass, "setsNamespace"> & { readonly parameters: readonly SqlParameter[] };
    expectTypeOf<protocol.ClassifiedStatement>().toExtend<Classified>();
    expectTypeOf<Classified>().toExtend<protocol.ClassifiedStatement>();
    expectTypeOf<keyof protocol.ClassifiedStatement>().toEqualTypeOf<keyof Classified>();
    expectTypeOf<protocol.StatementParameter>().toEqualTypeOf<SqlParameter>();
    expectTypeOf<protocol.ParameterValue>().toEqualTypeOf<ParameterValue>();
    expectTypeOf<protocol.FormatOptions>().toEqualTypeOf<FormatOptions>();
    expectTypeOf<FormatSettings>().toEqualTypeOf<FormatOptions>();
    expect(protocol.KEYWORD_CASES).toEqual(KEYWORD_CASES);
    expect(SETTINGS_KEYWORD_CASES).toEqual(KEYWORD_CASES);
    expect(protocol.FORMAT_STYLES).toEqual(FORMAT_STYLES);
    expect(SETTINGS_FORMAT_STYLES).toEqual(FORMAT_STYLES);
    expectTypeOf<protocol.TransactionMode>().toEqualTypeOf<TransactionMode>();
  });

  it("givenEditTypes_whenComparedWithCore_thenIdentical", () => {
    expectTypeOf<protocol.CellInput>().toEqualTypeOf<CellInput>();
    expectTypeOf<protocol.RowEdit>().toEqualTypeOf<RowEdit>();
    expectTypeOf<protocol.EditableIdentity>().toEqualTypeOf<EditableIdentity>();
    expectTypeOf<protocol.SubmittedEdits>().toEqualTypeOf<SubmittedEdits>();
    expectTypeOf<protocol.OrderTerm>().toEqualTypeOf<OrderTerm>();
    expectTypeOf<protocol.ColumnMeta>().toEqualTypeOf<ColumnMeta>();
  });

  it("givenCompletionTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.CompletionItem>().toEqualTypeOf<CompletionItem>();
    expectTypeOf<protocol.CompletionScope>().toEqualTypeOf<CompletionScope>();
    expectTypeOf<protocol.CompletionResult>().toEqualTypeOf<CompletionResult>();
    expectTypeOf<protocol.Declaration>().toEqualTypeOf<Declaration>();
    expect(protocol.COMPLETION_KINDS).toEqual(COMPLETION_KINDS);
  });

  it("givenInspectionTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.TextEdit>().toEqualTypeOf<TextEdit>();
    expectTypeOf<protocol.QuickFix>().toEqualTypeOf<QuickFix>();
    expectTypeOf<protocol.Problem>().toEqualTypeOf<Problem>();
    expectTypeOf<protocol.ProblemSeverity>().toEqualTypeOf<ProblemSeverity>();
    expectTypeOf<protocol.InspectionId>().toEqualTypeOf<InspectionId>();
    expect(protocol.PROBLEM_SEVERITIES).toEqual(PROBLEM_SEVERITIES);
    expect(protocol.INSPECTION_IDS).toEqual(INSPECTION_IDS);
  });

  it("givenImportTypes_whenComparedWithCoreAndPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.ImportFormat>().toEqualTypeOf<CoreImportFormat>();
    expectTypeOf<protocol.ImportTransaction>().toEqualTypeOf<CoreImportTransaction>();
    expectTypeOf<protocol.ImportErrorPolicy>().toEqualTypeOf<CoreImportErrorPolicy>();
    expectTypeOf<protocol.ImportKind>().toEqualTypeOf<ImportKind>();
    expect(protocol.IMPORT_ENCODINGS).toEqual(IMPORT_ENCODINGS);
    expect(protocol.IMPORT_FAILURE_REASONS).toEqual(IMPORT_FAILURE_REASONS);
    expect(protocol.IMPORT_KINDS).toEqual(IMPORT_KINDS);
  });

  it("givenExplainTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.Explainability>().toEqualTypeOf<Explainability>();
    expectTypeOf<protocol.PlanProperty>().toEqualTypeOf<PlanProperty>();
    expectTypeOf<protocol.PlanNode>().toEqualTypeOf<PlanNode>();
    expectTypeOf<protocol.ExplainedPlan>().toEqualTypeOf<ExplainedPlan>();
  });

  it("givenObjectTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.ObjectKind>().toEqualTypeOf<ObjectKind>();
    expectTypeOf<protocol.CatalogObject>().toEqualTypeOf<CatalogObject>();
    expectTypeOf<protocol.TableDesign>().toEqualTypeOf<TableDesign>();
    expectTypeOf<protocol.ObjectChange>().toEqualTypeOf<ObjectChange>();
    expectTypeOf<protocol.DdlScript>().toEqualTypeOf<DdlScript>();
    expectTypeOf<protocol.ObjectFeatures>().toEqualTypeOf<ObjectFeatures>();
    expect(protocol.OBJECT_KINDS).toEqual(OBJECT_KINDS);
  });

  it("givenSessionTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.ServerSessionState>().toEqualTypeOf<ServerSessionState>();
    expectTypeOf<protocol.ServerSession>().toEqualTypeOf<ServerSession>();
    expectTypeOf<protocol.SessionTarget>().toEqualTypeOf<SessionTarget>();
  });

  it("givenServerTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<protocol.ServerNode>().toEqualTypeOf<ServerNode>();
    expectTypeOf<protocol.ServerInfo>().toEqualTypeOf<ServerInfo>();
    expectTypeOf<protocol.SlowCommand>().toEqualTypeOf<SlowCommand>();
    expect(protocol.NODE_ROLES).toEqual(NODE_ROLES);
  });

  it("givenKeyspaceTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expect(protocol.KEY_TYPES).toEqual(KEY_TYPES);
    expectTypeOf<protocol.KeyBytes>().toEqualTypeOf<KeyBytes>();
    expectTypeOf<protocol.KeySource>().toEqualTypeOf<KeySource>();
    expectTypeOf<protocol.KeyDatabase>().toEqualTypeOf<KeyDatabase>();
    expectTypeOf<protocol.KeyScan>().toEqualTypeOf<KeyScan>();
    expectTypeOf<protocol.KeyInfo>().toEqualTypeOf<KeyInfo>();
    expectTypeOf<protocol.KeyExpiry>().toEqualTypeOf<KeyExpiry>();
    expectTypeOf<protocol.KeyDetails>().toEqualTypeOf<KeyDetails>();
    expectTypeOf<protocol.KeyChange>().toEqualTypeOf<KeyChange>();
    expectTypeOf<protocol.KeyApplyOptions>().toEqualTypeOf<KeyApplyOptions>();
    expectTypeOf<protocol.KeyApplied>().toEqualTypeOf<KeyApplied>();
  });

  it("givenCoreErrorCodes_whenComparedWithEngineErrorCodes_thenEveryOneIsCovered", () => {
    expectTypeOf<CoreErrorCode>().toExtend<protocol.EngineErrorCode>();
  });

  it("givenViteManifestName_whenComparedWithPluginApi_thenEqual", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = await readFile(new URL("../../packages/desktop/vite.plugins.config.ts", import.meta.url), "utf8");
    expect(config).toContain(`const MANIFEST_FILE = "${MANIFEST_FILE}";`);
  });
});
