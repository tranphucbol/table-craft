import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TunnelError,
  expandHome,
  fingerprintOf,
  keyNeedsPassphrase,
  openTunnel,
  type HostKeyOffer,
  type SshEndpoint,
  type Tunnel,
  type TunnelOptions,
} from "@table-craft/core";
import {
  KEY_PASSPHRASE,
  SSH_PASSWORD,
  SSH_USER,
  closedPort,
  roundTrip,
  startEchoServer,
  startSshServer,
  type TestSshServer,
} from "../support/sshServer.js";

const KEY_PATH = "/keys/id_ed25519";
const TIMEOUT_MS = 5_000;

let ssh: TestSshServer;
let echo: Awaited<ReturnType<typeof startEchoServer>>;
const opened: Tunnel[] = [];

beforeAll(async () => {
  [ssh, echo] = await Promise.all([startSshServer(), startEchoServer()]);
});

afterAll(async () => {
  await Promise.all(opened.map((tunnel) => tunnel.close()));
  await Promise.all([ssh.close(), echo.close()]);
});

function endpoint(overrides: Partial<SshEndpoint> = {}): SshEndpoint {
  return { host: "127.0.0.1", port: ssh.port, user: SSH_USER, auth: "password", password: SSH_PASSWORD, ...overrides };
}

async function open(overrides: Partial<TunnelOptions> = {}): Promise<Tunnel> {
  const tunnel = await openTunnel({
    ssh: endpoint(),
    target: { host: "127.0.0.1", port: echo.port },
    verifyHostKey: () => Promise.resolve(),
    timeoutMs: TIMEOUT_MS,
    ...overrides,
  });
  opened.push(tunnel);
  return tunnel;
}

async function failure(promise: Promise<unknown>): Promise<TunnelError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof TunnelError)) throw new Error(`expected a TunnelError, got ${String(error)}`);
  return error;
}

function keyFile(text: string): (path: string) => Promise<Buffer> {
  return (path) =>
    path === KEY_PATH ? Promise.resolve(Buffer.from(text)) : Promise.reject(new Error(`ENOENT: ${path}`));
}

describe("openTunnel", () => {
  it("givenSshPasswordAuth_whenConnect_thenQueriesRunThroughTunnel", async () => {
    const tunnel = await open();

    expect(await roundTrip(tunnel.localPort, "select 1")).toBe("select 1");
  });

  it("givenKeyWithPassphrase_whenConnect_thenTunnelOpens", async () => {
    const tunnel = await open({
      ssh: endpoint({ auth: "key", keyPath: KEY_PATH, passphrase: KEY_PASSPHRASE }),
      readFile: keyFile(ssh.encryptedKey),
    });

    expect(await roundTrip(tunnel.localPort, "key")).toBe("key");
  });

  it("givenUnencryptedKey_whenConnect_thenTunnelOpens", async () => {
    const tunnel = await open({ ssh: endpoint({ auth: "key", keyPath: KEY_PATH }), readFile: keyFile(ssh.plainKey) });

    expect(await roundTrip(tunnel.localPort, "plain")).toBe("plain");
  });

  it("givenEncryptedKeyWithoutPassphrase_whenConnect_thenAuthFailedNamesTheFile", async () => {
    const error = await failure(
      open({ ssh: endpoint({ auth: "key", keyPath: KEY_PATH }), readFile: keyFile(ssh.encryptedKey) }),
    );

    expect(error.code).toBe("sshAuthFailed");
    expect(error.message).toContain(KEY_PATH);
    expect(error.message).toContain("no passphrase");
  });

  it("givenWrongPassphrase_whenConnect_thenAuthFailedNamesTheFile", async () => {
    const error = await failure(
      open({
        ssh: endpoint({ auth: "key", keyPath: KEY_PATH, passphrase: "wrong" }),
        readFile: keyFile(ssh.encryptedKey),
      }),
    );

    expect(error.code).toBe("sshAuthFailed");
    expect(error.message).toContain(KEY_PATH);
  });

  it("givenMissingKeyFile_whenConnect_thenAuthFailedNamesTheFile", async () => {
    const error = await failure(open({ ssh: endpoint({ auth: "key", keyPath: "/nope" }), readFile: keyFile("") }));

    expect(error.code).toBe("sshAuthFailed");
    expect(error.message).toContain("/nope");
  });

  it("givenWrongPassword_whenConnect_thenSshAuthFailed", async () => {
    const error = await failure(open({ ssh: endpoint({ password: "wrong" }) }));

    expect(error.code).toBe("sshAuthFailed");
    expect(error.message).toContain(`${SSH_USER}@127.0.0.1:${String(ssh.port)}`);
  });

  it("givenAgentWithoutSocket_whenConnect_thenSshAuthFailed", async () => {
    const error = await failure(open({ ssh: endpoint({ auth: "agent" }), agent: "" }));

    expect(error.code).toBe("sshAuthFailed");
    expect(error.message).toContain("SSH_AUTH_SOCK");
  });

  it("givenUnreachableSshHost_whenConnect_thenSshHostUnreachable", async () => {
    const port = await closedPort();

    const error = await failure(open({ ssh: endpoint({ port }) }));

    expect(error.code).toBe("sshHostUnreachable");
    expect(error.message).toContain(`127.0.0.1:${String(port)}`);
  });

  it("givenHostKeyOffered_whenVerified_thenOfferCarriesOpenSshFingerprint", async () => {
    const offers: HostKeyOffer[] = [];

    await open({
      verifyHostKey: (offer) => {
        offers.push(offer);
        return Promise.resolve();
      },
    });

    expect(offers).toEqual([
      {
        host: "127.0.0.1",
        port: ssh.port,
        algorithm: "ssh-ed25519",
        fingerprint: fingerprintOf(ssh.hostKey),
        key: ssh.hostKey.toString("base64"),
      },
    ]);
    expect(offers[0]?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("givenVerifierRefuses_whenConnect_thenItsErrorIsThrown", async () => {
    const refusal = new TunnelError("sshHostKeyUnknown", "not trusted", "trust it");

    const error = await failure(open({ verifyHostKey: () => Promise.reject(refusal) }));

    expect(error).toBe(refusal);
  });

  it("givenVerifierPending_whenTimeoutPasses_thenHandshakeWaits", async () => {
    const tunnel = await open({
      timeoutMs: 100,
      verifyHostKey: () => new Promise((resolve) => setTimeout(resolve, 400)),
    });

    expect(await roundTrip(tunnel.localPort, "waited")).toBe("waited");
  });

  it("givenRefusedForward_whenSocketConnects_thenForwardErrorNamesTarget", async () => {
    const port = await closedPort();
    ssh.refusedPorts.add(port);
    const tunnel = await open({ target: { host: "db.internal", port } });

    await expect(roundTrip(tunnel.localPort, "x")).rejects.toThrow();

    expect(tunnel.forwardError).toContain(`db.internal:${String(port)}`);
  });

  it("givenClose_whenCalled_thenListenersHearNullAndPortStopsListening", async () => {
    const tunnel = await open();
    const reasons: (string | null)[] = [];
    tunnel.onClose((reason) => reasons.push(reason));

    await tunnel.close();

    expect(reasons).toEqual([null]);
    await expect(roundTrip(tunnel.localPort, "x")).rejects.toThrow();
  });

  it("givenServerDropsConnection_whenDropped_thenListenersHearAReason", async () => {
    const tunnel = await open();
    const closed = new Promise<string | null>((resolve) => tunnel.onClose(resolve));

    ssh.dropClients();

    expect(await closed).toEqual(expect.any(String));
  });
});

describe("expandHome", () => {
  it("givenTildePath_whenExpanded_thenHomeReplacesOnlyALeadingTilde", () => {
    expect(expandHome("~/.ssh/id_ed25519", "/home/me")).toBe("/home/me/.ssh/id_ed25519");
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~other/key", "/home/me")).toBe("~other/key");
    expect(expandHome("/keys/~/id", "/home/me")).toBe("/keys/~/id");
  });
});

describe("keyNeedsPassphrase", () => {
  it("givenEncryptedOpenSshKey_whenRead_thenTrue", () => {
    expect(keyNeedsPassphrase(ssh.encryptedKey)).toBe(true);
  });

  it("givenPlainOpenSshKey_whenRead_thenFalse", () => {
    expect(keyNeedsPassphrase(ssh.plainKey)).toBe(false);
  });

  it("givenEncryptedPemKey_whenRead_thenTrue", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----\n";

    expect(keyNeedsPassphrase(pem)).toBe(true);
  });

  it("givenNotAKey_whenRead_thenFalse", () => {
    expect(keyNeedsPassphrase("hello")).toBe(false);
  });
});
