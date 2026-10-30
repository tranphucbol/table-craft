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

/** The plugin's `CommandAdmission` verdicts, as `commands.admit` answers them (plan 110). */
export const COMMAND_ADMISSIONS = ["execute", "omitHistory", "managed", "reject"] as const;
export type CommandAdmissionVerdict = (typeof COMMAND_ADMISSIONS)[number];

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

export type CommandIntentArguments =
  | { readonly kind: "watch"; readonly request: KeyWatchRequest }
  | { readonly kind: "credentials"; readonly change: "createUser" | "changePassword"; readonly user: string }
  | { readonly kind: "keepAlive"; readonly leaseId: string }
  | { readonly kind: "leaseRevoke"; readonly leaseId: string }
  | { readonly kind: "none" };

/** One command's admission; `intent` and `arguments` come only with `managed`. */
export type CommandAdmission =
  | { readonly admit: "execute" | "omitHistory" | "reject"; readonly safeLabel: string }
  | {
      readonly admit: "managed";
      readonly intent: CommandIntent;
      readonly arguments: CommandIntentArguments;
      readonly safeLabel: string;
    };

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
