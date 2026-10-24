import type { KnownHosts } from "@table-craft/core";
import type { HostKeyOffer, HostKeyVerdict } from "@table-craft/desktop/engine/protocol.js";

export interface HostKeyServiceOptions {
  readonly knownHosts: KnownHosts;
  /** Asks the user whether to trust an unknown key; false when declined or there is no window to ask in. */
  readonly ask: (offer: HostKeyOffer) => Promise<boolean>;
}

/**
 * Rules on the host keys engines are offered (decision 071): a recorded key passes, a different key
 * for a recorded host is refused without asking, an unknown key is trusted only once the user says
 * so, and then recorded. Engines opening tunnels to the same server at once share one question.
 */
export function createHostKeyService(options: HostKeyServiceOptions): (offer: HostKeyOffer) => Promise<HostKeyVerdict> {
  const pending = new Map<string, Promise<HostKeyVerdict>>();

  async function rule(offer: HostKeyOffer): Promise<HostKeyVerdict> {
    const check = await options.knownHosts.check(offer);
    if (check.status === "trusted") return { verdict: "trusted" };
    if (check.status === "changed") {
      return { verdict: "changed", knownFingerprint: check.knownFingerprint, file: check.file };
    }
    if (!(await options.ask(offer))) return { verdict: "rejected" };
    await options.knownHosts.trust(offer);
    return { verdict: "trusted" };
  }

  return (offer) => {
    const key = `${offer.host}:${String(offer.port)} ${offer.fingerprint}`;
    const known = pending.get(key);
    if (known !== undefined) return known;
    const ruling = rule(offer).finally(() => pending.delete(key));
    pending.set(key, ruling);
    return ruling;
  };
}
