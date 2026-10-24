import { describe, expect, it } from "vitest";
import { createKnownHosts, fingerprintOf } from "@table-craft/core";
import type { HostKeyOffer } from "@table-craft/desktop/engine/protocol.js";
import { createHostKeyService } from "@table-craft/desktop/main/hostKeys.js";

const APP_FILE = "/profile/ssh_known_hosts.json";
function offerOf(blob: string): HostKeyOffer {
  const key = Buffer.from(blob);
  return {
    host: "bastion",
    port: 22,
    algorithm: "ssh-ed25519",
    fingerprint: fingerprintOf(key),
    key: key.toString("base64"),
  };
}

const OFFER = offerOf("first-key");
const CHANGED = offerOf("second-key");

function service(answers: boolean[]) {
  const contents = new Map<string, string>();
  const asked: HostKeyOffer[] = [];
  const knownHosts = createKnownHosts({
    appFile: APP_FILE,
    userFile: null,
    files: {
      readText: (path) => Promise.resolve(contents.get(path) ?? null),
      writeText: (path, text) => {
        contents.set(path, text);
        return Promise.resolve();
      },
    },
  });
  const rule = createHostKeyService({
    knownHosts,
    ask: (offer) => {
      asked.push(offer);
      return Promise.resolve(answers.shift() ?? false);
    },
  });
  return { rule, asked, contents };
}

describe("host key service", () => {
  it("givenUnknownHostKey_whenConnect_thenAsksBeforeTrusting", async () => {
    const { rule, asked, contents } = service([true]);

    expect(await rule(OFFER)).toEqual({ verdict: "trusted" });
    expect(asked).toEqual([OFFER]);
    expect(contents.get(APP_FILE)).toContain(OFFER.key);

    expect(await rule(OFFER)).toEqual({ verdict: "trusted" });
    expect(asked).toHaveLength(1);
  });

  it("givenUnknownKeyDeclined_whenRuled_thenRejectedAndNotRecorded", async () => {
    const { rule, contents } = service([false]);

    expect(await rule(OFFER)).toEqual({ verdict: "rejected" });
    expect(contents.has(APP_FILE)).toBe(false);
  });

  it("givenChangedHostKey_whenConnect_thenRefusesWithBothFingerprints", async () => {
    const { rule, asked } = service([true, true]);
    await rule(OFFER);

    const verdict = await rule(CHANGED);

    expect(verdict).toEqual({ verdict: "changed", knownFingerprint: OFFER.fingerprint, file: APP_FILE });
    expect(asked).toHaveLength(1);
  });

  it("givenTwoEnginesOfferSameKey_whenRuledAtOnce_thenAskedOnce", async () => {
    const { rule, asked } = service([true]);

    const verdicts = await Promise.all([rule(OFFER), rule(OFFER)]);

    expect(verdicts).toEqual([{ verdict: "trusted" }, { verdict: "trusted" }]);
    expect(asked).toHaveLength(1);
  });
});
