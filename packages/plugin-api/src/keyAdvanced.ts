import type { KeyBytes, KeyRevision } from "./keyspace.js";

/** Namespace-relative byte ranges; range ends are exclusive. */
export type KeyRange =
  | { readonly kind: "key"; readonly key: KeyBytes }
  | { readonly kind: "prefix"; readonly prefix: KeyBytes }
  | { readonly kind: "range"; readonly from: KeyBytes; readonly to: KeyBytes }
  | { readonly kind: "all" };

/** A complete key, never a truncated preview. */
export interface KeyRecord {
  readonly key: KeyBytes;
  readonly value: KeyBytes;
  readonly revision: KeyRevision;
}

/** Omission on apply means preserve, including when only the lease changes. */
export type KeyLeaseAssignment =
  { readonly kind: "preserve" } | { readonly kind: "detach" } | { readonly kind: "attach"; readonly leaseId: string };

export interface KeyChildrenRequest {
  readonly database: number;
  readonly range: KeyRange;
  readonly parent: KeyBytes;
  readonly cursor: string | null;
  readonly count: number;
  readonly timeoutMs: number;
}

export interface KeyChildrenPage {
  readonly revision: string;
  readonly children: readonly {
    readonly kind: "key" | "folder";
    readonly key: KeyBytes;
    readonly revision?: KeyRevision;
  }[];
  readonly cursor: string | null;
}

export interface KeyRangeCount {
  readonly revision: string;
  readonly keys: string | null;
  readonly leasedKeys: string | null;
}

/** Tokens bind session, namespace, exact range and baseline, and expire on disconnect. */
export interface KeyDeletePreview {
  readonly token: string;
  readonly revision: string;
  readonly counts: KeyRangeCount;
  readonly sampleKeys: readonly KeyBytes[];
  readonly guard: "noNewOrModifiedKeys";
}

export interface KeyDeleteResult {
  readonly revision: string;
  readonly deleted: string;
}

export interface LeaseInfo {
  readonly id: string;
  readonly state: "active" | "expired" | "unknown";
  readonly grantedTtlSeconds: string | null;
  readonly remainingTtlSeconds: string | null;
  readonly scopedKeyCount: string | null;
  readonly totalKeyCount: string | null;
  readonly outsideNamespaceKeyCount: string | null;
}

export interface LeaseKeyPage {
  readonly lease: LeaseInfo;
  readonly keys: readonly KeyBytes[];
  readonly cursor: string | null;
}

export interface LeaseRevokePreview {
  readonly token: string;
  readonly lease: LeaseInfo;
  readonly sampleKeys: readonly KeyBytes[];
}

/** Closing renewal never revokes the lease. */
export interface LeaseKeepAlive {
  once(): Promise<LeaseInfo>;
  close(): Promise<void>;
  /**
   * Called at most once when renewal stops on its own (stream failure, an unconfirmed heartbeat,
   * expiry), with a reason for the user; never after `close`. Without it the host cannot tell a
   * dead renewal from a live one.
   */
  onClosed?(listener: (reason: string) => void): void;
}

export interface LeaseManager {
  list(): Promise<readonly LeaseInfo[]>;
  get(id: string): Promise<LeaseInfo>;
  keys(id: string, cursor: string | null, count: number): Promise<LeaseKeyPage>;
  grant(ttlSeconds: string): Promise<LeaseInfo>;
  keepAliveOnce(id: string): Promise<LeaseInfo>;
  keepAlive(id: string): Promise<LeaseKeepAlive>;
  prepareRevoke(id: string): Promise<LeaseRevokePreview>;
  revokePrepared(token: string): Promise<void>;
}

export interface KeyWatchRequest {
  readonly database: number;
  readonly range: KeyRange;
  readonly from: { readonly kind: "now" } | { readonly kind: "revision"; readonly revision: string };
}

export interface KeyWatchEvent {
  readonly kind: "PUT" | "DELETE";
  readonly key: KeyBytes;
  readonly revision: KeyRevision;
  readonly value: KeyBytes | null;
  readonly previous: KeyRecord | null;
}

export interface KeyWatchGap {
  readonly reason: "compacted" | "overflow" | "eventTooLarge";
  readonly fromRevision: string;
  readonly toRevision: string | null;
}

export type KeyWatchState = "live" | "reconnecting" | "gap" | "stopped";

export interface KeyWatchBatch {
  readonly events: readonly KeyWatchEvent[];
  readonly state: KeyWatchState;
  readonly completedRevision: string | null;
  readonly gap: KeyWatchGap | null;
}

/** completedRevision advances only after an entire revision has been delivered. */
export interface KeyWatch {
  next(request: {
    readonly count: number;
    readonly maxBytes: number;
    readonly timeoutMs: number;
  }): Promise<KeyWatchBatch>;
  close(): Promise<void>;
}

export interface KeyWatcher {
  open(request: KeyWatchRequest): Promise<KeyWatch>;
}

export interface ClusterEndpoint {
  readonly id: string;
  readonly label: string;
  readonly memberId: string | null;
  readonly reachable: boolean;
  readonly error: string | null;
}

export interface ClusterMember {
  readonly id: string;
  readonly name: string;
  readonly learner: boolean;
  readonly peerUrls: readonly string[];
  readonly clientUrls: readonly string[];
}

export interface ClusterStatus {
  readonly endpointId: string;
  readonly clusterId: string;
  readonly memberId: string;
  readonly revision: string;
  readonly leaderId: string | null;
  readonly version: string | null;
  readonly dbBytes: string | null;
  readonly inUseBytes: string | null;
  readonly quotaBytes: string | null;
  readonly raftTerm: string | null;
  readonly raftIndex: string | null;
  readonly appliedIndex: string | null;
}

export interface ClusterAlarm {
  readonly memberId: string;
  readonly kind: "NOSPACE" | "CORRUPT" | "unknown";
}

export interface ClusterHash {
  readonly endpointId: string;
  readonly revision: string;
  readonly hash: string;
  readonly compactRevision: string;
}

/** Full sensitive backend, not a namespace export; the host verifies before publishing. */
export interface ClusterSnapshot {
  readonly chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

export interface ClusterManager {
  endpoints(): Promise<readonly ClusterEndpoint[]>;
  members(): Promise<readonly ClusterMember[]>;
  status(endpointId: string): Promise<ClusterStatus>;
  alarms(): Promise<readonly ClusterAlarm[]>;
  disarm(alarm: ClusterAlarm): Promise<void>;
  compact(revision: string, physical: boolean): Promise<void>;
  defragment(endpointId: string): Promise<void>;
  hash(endpointId: string, revision: string): Promise<ClusterHash>;
  snapshot(endpointId: string): Promise<ClusterSnapshot>;
  promote(memberId: string): Promise<void>;
  remove(memberId: string): Promise<void>;
}

export interface AccessStatus {
  readonly enabled: boolean;
  readonly revision: string | null;
  readonly currentUser: string | null;
}

export interface AccessUser {
  readonly name: string;
  readonly roles: readonly string[];
}

export interface AccessPermission {
  readonly access: "read" | "write" | "readwrite";
  readonly range: KeyRange;
}

export interface AccessRole {
  readonly name: string;
  readonly permissions: readonly AccessPermission[];
}

export type AccessChange =
  | { readonly kind: "deleteUser"; readonly user: string }
  | { readonly kind: "grantRole" | "revokeRole"; readonly user: string; readonly role: string }
  | { readonly kind: "createRole" | "deleteRole"; readonly role: string }
  | { readonly kind: "grantPermission"; readonly role: string; readonly permission: AccessPermission }
  | { readonly kind: "revokePermission"; readonly role: string; readonly range: KeyRange }
  | { readonly kind: "enableAuth" | "disableAuth" };

/** Write-only credential transport only: never ordinary engine calls, history, logs or results. */
export type AccessSecretChange = {
  readonly kind: "createUser" | "changePassword";
  readonly user: string;
  readonly password: string;
};

export interface AccessManager {
  status(): Promise<AccessStatus>;
  users(): Promise<readonly AccessUser[]>;
  roles(): Promise<readonly AccessRole[]>;
  apply(change: AccessChange): Promise<void>;
  applySecret(change: AccessSecretChange): Promise<void>;
}

export interface CoordinationPrefix {
  readonly id: string;
  readonly kind: "lock" | "election";
  readonly prefix: KeyBytes;
}

export interface CoordinationCandidate {
  readonly key: KeyBytes;
  readonly createRevision: string;
  readonly leaseId: string;
  readonly value: KeyBytes;
}

export interface CoordinationQueue {
  readonly name: KeyBytes;
  readonly kind: "lock" | "election";
  readonly candidates: readonly CoordinationCandidate[];
  readonly complete: boolean;
}

export interface CoordinationPage {
  readonly revision: string;
  readonly queues: readonly CoordinationQueue[];
  readonly cursor: string | null;
}

export interface CoordinationViewer {
  prefixes(): Promise<readonly CoordinationPrefix[]>;
  read(prefixId: string, cursor: string | null, count: number): Promise<CoordinationPage>;
}

export interface CommandTransactionCompare {
  readonly range: KeyRange;
  readonly target: "value" | "version" | "createRevision" | "modRevision" | "lease";
  readonly operator: "=" | "!=" | "<" | ">";
  readonly operand: KeyBytes | string;
}

export type CommandTransactionOperation =
  | { readonly kind: "get" | "delete"; readonly range: KeyRange }
  | { readonly kind: "put"; readonly key: KeyBytes; readonly value: KeyBytes; readonly lease: KeyLeaseAssignment }
  | { readonly kind: "txn"; readonly transaction: CommandTransaction };

export interface CommandTransaction {
  readonly compare: readonly CommandTransactionCompare[];
  readonly success: readonly CommandTransactionOperation[];
  readonly failure: readonly CommandTransactionOperation[];
}

export type CommandTransactionParsed =
  | { readonly kind: "parsed"; readonly transaction: CommandTransaction; readonly from: number; readonly to: number }
  | { readonly kind: "unparsed"; readonly reason: string };

export interface CommandTransactionSerialized {
  readonly text: string;
  readonly operationCount: number;
  readonly operationLimit: number | null;
  readonly errors: readonly string[];
}

export interface CommandTransactionBuilder {
  parse(text: string, offset: number): CommandTransactionParsed;
  serialize(transaction: CommandTransaction): CommandTransactionSerialized;
}

/**
 * What the host may do with one console command before it records, shows or runs it (plan 110):
 * `execute` runs it as an ordinary statement, `omitHistory` runs it but keeps its text out of
 * history, Services, Output and results, `managed` opens the matching manager instead, and
 * `reject` runs nothing and shows no part of the text.
 */
export const COMMAND_ADMISSIONS = ["execute", "omitHistory", "managed", "reject"] as const;
export type CommandAdmissionVerdict = (typeof COMMAND_ADMISSIONS)[number];

/** The manager a `managed` command opens. */
export const COMMAND_INTENTS = [
  "watch",
  "snapshot",
  "keepAlive",
  "credentials",
  "access",
  "cluster",
  "leaseRevoke",
  "leaseGrant",
  "admin",
] as const;
export type CommandIntent = (typeof COMMAND_INTENTS)[number];

/**
 * The validated parameters a manager starts from, parsed by the plugin, never raw command text.
 * `none` opens the manager without a preset.
 */
export type CommandIntentArguments =
  | { readonly kind: "watch"; readonly request: KeyWatchRequest }
  | { readonly kind: "credentials"; readonly change: "createUser" | "changePassword"; readonly user: string }
  | { readonly kind: "keepAlive"; readonly leaseId: string }
  | { readonly kind: "leaseRevoke"; readonly leaseId: string }
  | { readonly kind: "none" };

export interface CommandAdmission {
  readonly admit: CommandAdmissionVerdict;
  /** Present exactly when `admit` is `managed`. */
  readonly intent?: CommandIntent;
  /** Present exactly when `admit` is `managed`. */
  readonly arguments?: CommandIntentArguments;
  /** The command's canonical name, safe to show and record in place of its text; never an argument. */
  readonly safeLabel: string;
}

export interface KeyTransferEntry {
  readonly key: KeyBytes;
  readonly value: KeyBytes;
  readonly expectedModRevision: string | null;
}

export type KeyTransferPolicy = "skipExisting" | "overwrite" | "ifUnchanged";

export interface KeyTransferExportRequest {
  readonly database: number;
  readonly range: KeyRange;
  readonly cursor: string | null;
  readonly count: number;
  readonly maxBytes: number;
}

export interface KeyTransferExportPage {
  readonly clusterId: string;
  readonly namespace: KeyBytes;
  readonly revision: string;
  readonly records: readonly KeyRecord[];
  readonly cursor: string | null;
}

export interface KeyTransferInspection {
  readonly newKeys: string;
  readonly changedKeys: string;
  readonly sameKeys: string;
  readonly conflicts: string;
}

export interface KeyTransferImported {
  readonly revision: string;
  readonly written: string;
  readonly skipped: string;
}

export interface KeyTransfer {
  exportPage(request: KeyTransferExportRequest): Promise<KeyTransferExportPage>;
  inspect(entries: readonly KeyTransferEntry[]): Promise<KeyTransferInspection>;
  importChunk(entries: readonly KeyTransferEntry[], policy: KeyTransferPolicy): Promise<KeyTransferImported>;
}

export interface ConnectionEndpoint {
  readonly id: string;
  readonly host: string;
  readonly port: number;
}

/** When provided, this entire list replaces configured network addresses; never discover around it. */
export interface ConnectionTransport extends ConnectionEndpoint {
  readonly serverName: string;
}
