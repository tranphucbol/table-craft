import type {
  AccessChange,
  AccessRole,
  AccessStatus,
  AccessUser,
  ClusterAlarm,
  ClusterEndpoint,
  ClusterHash,
  ClusterMember,
  ClusterStatus,
  CommandAdmission,
  CommandTransaction,
  CommandTransactionParsed,
  CommandTransactionSerialized,
  CoordinationPage,
  CoordinationPrefix,
  KeyChildrenPage,
  KeyChildrenRequest,
  KeyDeletePreview,
  KeyDeleteResult,
  KeyRange,
  KeyRangeCount,
  KeyTransferInspection,
  KeyTransferPolicy,
  KeyWatchEvent,
  KeyWatchGap,
  KeyWatchRequest,
  KeyWatchState,
  LeaseInfo,
  LeaseKeyPage,
  LeaseRevokePreview,
} from "./keyAdvanced.js";
import type { KeyspaceFeatures } from "./keyspace.js";

export const KEY_ADVANCED_MAX_COUNT = 500;
export const KEY_ADVANCED_MAX_BYTES = 1_048_576;
export const KEY_ADVANCED_MAX_TIMEOUT_MS = 5_000;
export const KEY_ADVANCED_MAX_CURSOR_LENGTH = 8_192;
export const KEY_ADVANCED_MAX_TEXT = 200_000;
export const COMMAND_TXN_MAX_DEPTH = 8;
export const COMMAND_TXN_MAX_OPERATIONS = 128;
/** Commands per `commands.admit` request; the console asks in batches of at most this many. */
export const COMMAND_ADMIT_MAX_COMMANDS = 1_000;
/** One command's text for `commands.admit`; the etcd execution parser's own cap is 1 MiB of UTF-8. */
export const COMMAND_ADMIT_MAX_TEXT = 1_048_576;
/** A `safeLabel` longer than this is not a command name, so the engine rejects the command. */
export const COMMAND_ADMIT_MAX_LABEL = 64;
export const KEY_WATCH_MAX_EVENTS = 100_000;
export const KEY_WATCH_MAX_RING_BYTES = 67_108_864;

export interface KeyWatchWindow {
  readonly watchId: string;
  readonly rows: readonly { readonly sequence: string; readonly event: KeyWatchEvent }[];
  readonly oldestSequence: string | null;
  readonly newestSequence: string | null;
  readonly evictedEvents: string;
  readonly state: KeyWatchState;
  readonly completedRevision: string | null;
  readonly gap: KeyWatchGap | null;
}

export interface KeyWatchSummary {
  readonly watchId: string;
  readonly request: KeyWatchRequest;
  readonly state: KeyWatchState;
  readonly completedRevision: string | null;
  readonly gap: KeyWatchGap | null;
  readonly evictedEvents: string;
}

export interface LeaseKeepAliveStarted {
  readonly keepAliveId: string;
  readonly lease: LeaseInfo;
}
export interface ManagedLeaseInfo extends LeaseInfo {
  readonly renewal?: {
    readonly keepAliveId: string;
    readonly state: "active" | "stopped";
    readonly reason: string | null;
  };
}

export type KeyTaskKind = "defragment" | "snapshot" | "consistency" | "import" | "export" | "watchExport";
export type KeyTaskState = "running" | "completed" | "failed" | "cancelled";

export interface KeyTask {
  readonly taskId: string;
  readonly kind: KeyTaskKind;
  readonly state: KeyTaskState;
  readonly completed: string;
  readonly total: string | null;
  readonly error: string | null;
  readonly outcome: "confirmed" | "uncertain";
  readonly resumable: boolean;
  readonly hashes?: readonly ClusterHash[];
}

/** All calls are already scoped to the engine's datasource. Streams/tasks own dedicated sessions. */
export interface KeyAdvancedCalls {
  "keyspace.features": {
    params: Record<never, never>;
    result: KeyspaceFeatures & {
      readonly children: boolean;
      readonly countRange: boolean;
      readonly prepareDelete: boolean;
      readonly history: boolean;
    };
  };
  "keyspace.children": { params: KeyChildrenRequest; result: KeyChildrenPage };
  "keyspace.countRange": { params: { readonly database: number; readonly range: KeyRange }; result: KeyRangeCount };
  "keyspace.prepareDelete": {
    params: { readonly database: number; readonly range: KeyRange };
    result: KeyDeletePreview;
  };
  "keyspace.deletePrepared": { params: { readonly token: string }; result: KeyDeleteResult };
  "leases.list": { params: Record<never, never>; result: readonly ManagedLeaseInfo[] };
  "leases.get": { params: { readonly leaseId: string }; result: LeaseInfo };
  "leases.keys": {
    params: { readonly leaseId: string; readonly cursor: string | null; readonly count: number };
    result: LeaseKeyPage;
  };
  "leases.grant": { params: { readonly ttlSeconds: string }; result: LeaseInfo };
  "leases.keepAliveOnce": { params: { readonly leaseId: string }; result: LeaseInfo };
  "leases.keepAliveStart": { params: { readonly leaseId: string }; result: LeaseKeepAliveStarted };
  "leases.keepAliveStop": { params: { readonly keepAliveId: string }; result: null };
  "leases.prepareRevoke": { params: { readonly leaseId: string }; result: LeaseRevokePreview };
  "leases.revokePrepared": { params: { readonly token: string }; result: null };
  "watch.start": {
    params: KeyWatchRequest & { readonly maxEvents: number; readonly maxBytes: number };
    result: KeyWatchSummary;
  };
  "watch.window": {
    params: {
      readonly watchId: string;
      readonly afterSequence: string | null;
      readonly count: number;
      readonly maxBytes: number;
    };
    result: KeyWatchWindow;
  };
  "watch.stop": { params: { readonly watchId: string }; result: null };
  "watch.clear": { params: { readonly watchId: string }; result: null };
  "watch.list": { params: Record<never, never>; result: readonly KeyWatchSummary[] };
  "watch.exportStart": { params: { readonly watchId: string; readonly fileGrantId: string }; result: KeyTask };
  "watch.exportList": { params: Record<never, never>; result: readonly KeyTask[] };
  "watch.exportCancel": { params: { readonly taskId: string }; result: null };
  "cluster.endpoints": { params: Record<never, never>; result: readonly ClusterEndpoint[] };
  "cluster.members": { params: Record<never, never>; result: readonly ClusterMember[] };
  "cluster.status": { params: { readonly endpointId: string }; result: ClusterStatus };
  "cluster.alarms": { params: Record<never, never>; result: readonly ClusterAlarm[] };
  "cluster.disarm": { params: { readonly alarm: ClusterAlarm }; result: null };
  "cluster.compact": { params: { readonly revision: string; readonly physical: boolean }; result: null };
  "cluster.promote": { params: { readonly memberId: string }; result: null };
  "cluster.remove": { params: { readonly memberId: string }; result: null };
  "maintenance.defragmentStart": { params: { readonly endpointIds: readonly string[] }; result: KeyTask };
  "maintenance.snapshotStart": {
    params: { readonly endpointId: string; readonly fileGrantId: string };
    result: KeyTask;
  };
  "maintenance.consistencyStart": {
    params: { readonly endpointIds: readonly string[]; readonly revision: string };
    result: KeyTask;
  };
  "maintenance.list": { params: Record<never, never>; result: readonly KeyTask[] };
  "maintenance.cancel": { params: { readonly taskId: string }; result: null };
  "access.status": { params: Record<never, never>; result: AccessStatus };
  "access.users": { params: Record<never, never>; result: readonly AccessUser[] };
  "access.roles": { params: Record<never, never>; result: readonly AccessRole[] };
  "access.apply": { params: { readonly change: AccessChange }; result: null };
  "coordination.prefixes": { params: Record<never, never>; result: readonly CoordinationPrefix[] };
  "coordination.read": {
    params: { readonly prefixId: string; readonly cursor: string | null; readonly count: number };
    result: CoordinationPage;
  };
  /**
   * Each command's admission before the console records, shows or runs it (plan 110), in order.
   * Every command executes when the plugin has no `admit`; a command it fails on is rejected.
   * Never logs the text.
   */
  "commands.admit": { params: { readonly commands: readonly string[] }; result: readonly CommandAdmission[] };
  "commandTxn.parse": { params: { readonly text: string; readonly offset: number }; result: CommandTransactionParsed };
  "commandTxn.serialize": {
    params: { readonly transaction: CommandTransaction };
    result: CommandTransactionSerialized;
  };
  "keyTransfer.previewImport": {
    params: { readonly fileGrantId: string; readonly database: number; readonly range: KeyRange };
    result: KeyTransferInspection;
  };
  "keyTransfer.importStart": {
    params: {
      readonly fileGrantId: string;
      readonly database: number;
      readonly range: KeyRange;
      readonly policy: KeyTransferPolicy;
    };
    result: KeyTask;
  };
  "keyTransfer.exportStart": {
    params: { readonly fileGrantId: string; readonly database: number; readonly range: KeyRange };
    result: KeyTask;
  };
  "keyTransfer.resume": { params: { readonly taskId: string }; result: KeyTask };
  "keyTransfer.list": { params: Record<never, never>; result: readonly KeyTask[] };
  "keyTransfer.cancel": { params: { readonly taskId: string }; result: null };
}
