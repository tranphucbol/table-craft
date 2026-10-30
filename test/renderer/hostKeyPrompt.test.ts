import { describe, expect, it } from "vitest";
import type { HostKeyPrompt } from "@table-craft/desktop/preload/bridge.js";
import { sshServerName } from "@table-craft/desktop/renderer/dialogs/HostKeyPrompt.js";
import { inSentence, promptDescription } from "@table-craft/desktop/renderer/dialogs/SecretPrompt.js";
import type { SecretRequest } from "@table-craft/desktop/renderer/state/datasources.js";
import { createHostKeyPromptStore } from "@table-craft/desktop/renderer/state/hostKeyPrompt.js";

function prompt(requestId: number, host: string): HostKeyPrompt {
  return {
    requestId,
    offer: { host, port: 2204, algorithm: "ssh-ed25519", fingerprint: `SHA256:${host}`, key: "AAAA" },
  };
}

describe("host key prompt", () => {
  it("givenTwoUnknownKeys_whenAnswered_thenEachRuledOnceInOrder", () => {
    const answers: [number, boolean][] = [];
    const store = createHostKeyPromptStore((requestId, trust) => answers.push([requestId, trust]));

    store.getState().ask(prompt(1, "a"));
    store.getState().ask(prompt(2, "b"));
    store.getState().answer(1, true);
    store.getState().answer(1, false);

    expect(store.getState().queue.map((pending) => pending.requestId)).toEqual([2]);
    store.getState().answer(2, false);
    expect(answers).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(store.getState().queue).toEqual([]);
  });

  it("givenPort_whenServerNamed_thenBareOn22", () => {
    expect(sshServerName("bastion", 22)).toBe("bastion");
    expect(sshServerName("bastion", 2204)).toBe("bastion:2204");
  });

  it("givenSshLabel_whenPutInSentence_thenAcronymKeptAndRestLowered", () => {
    expect(inSentence("SSH password")).toBe("SSH password");
    expect(inSentence("Key passphrase")).toBe("key passphrase");
    expect(inSentence("Password")).toBe("password");
  });

  it("givenFieldsInEachMode_whenDescribed_thenEachSaysHowItIsKept", () => {
    const request = {
      datasource: { name: "pg", secretModes: { password: "forever", "ssh.password": "untilRestart" } },
      fields: [
        { key: "password", label: "Password", kind: "password", secret: true },
        { key: "ssh.password", label: "SSH password", kind: "password", secret: true },
        { key: "ssh.passphrase", label: "Key passphrase", kind: "password", secret: true },
      ],
    } as unknown as SecretRequest;

    expect(promptDescription(request)).toBe(
      "TableCraft saves the password in the system keychain. TableCraft keeps the SSH password until it quits. " +
        "pg does not keep its key passphrase. It is used for this connection only.",
    );
  });
});
