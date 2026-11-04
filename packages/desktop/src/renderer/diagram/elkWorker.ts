import ELK, { type ElkNode } from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";

const LAYERED = "layered";

let elk: InstanceType<typeof ELK> | null = null;
const latest = new Map<string, number>();

/**
 * Lays `graph` out in the window's one ELK worker (plan 152 decision 12), started on the first diagram.
 * The worker file ships unmodified beside the bundle, so the CSP's `script-src 'self'` admits it. ELK
 * answers requests in order and cannot abandon one mid-run, so a newer request for the same tab makes
 * the older one's answer `null` instead.
 */
export async function layOut(tabId: string, graph: ElkNode): Promise<ElkNode | null> {
  elk ??= new ELK({ workerUrl: elkWorkerUrl, algorithms: [LAYERED] });
  const request = (latest.get(tabId) ?? 0) + 1;
  latest.set(tabId, request);
  const laidOut = await elk.layout(graph);
  return latest.get(tabId) === request ? laidOut : null;
}

/** Forgets a closed tab's requests, so an answer still in flight is dropped. */
export function forgetLayouts(tabId: string): void {
  latest.delete(tabId);
}
