import {
  homeExpanded,
  isPluginError,
  isTlsSettingsError,
  PluginError,
  TlsSettingsError,
  tlsFailureMessage,
  tlsFileMessage,
  tlsKeyIsEncrypted,
  tlsKeyMessage,
} from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";

const CA_LABEL = "SSL root certificate";
const CA_PATH = "/certs/ca.pem";

function failure(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

describe("homeExpanded", () => {
  it("givenTildePath_whenExpanded_thenHomeReplacesTilde", () => {
    expect(homeExpanded("~/certs/ca.pem", "/home/me")).toBe("/home/me/certs/ca.pem");
    expect(homeExpanded("~", "/home/me")).toBe("/home/me");
  });

  it("givenOtherPath_whenExpanded_thenUnchanged", () => {
    expect(homeExpanded("/certs/~/ca.pem", "/home/me")).toBe("/certs/~/ca.pem");
    expect(homeExpanded("~other/ca.pem", "/home/me")).toBe("~other/ca.pem");
  });
});

describe("tlsFailureMessage", () => {
  const verification = { caLabel: CA_LABEL, caPath: CA_PATH, host: "db.example.com" };

  it("givenHostMismatch_whenWorded_thenNamesHostAndVerifyCa", () => {
    const message = tlsFailureMessage(
      failure("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match"),
      verification,
    );

    expect(message).toContain("not valid for host db.example.com");
    expect(message).toContain("Verify CA");
  });

  it("givenChainErrorWithCaFile_whenWorded_thenNamesCaFile", () => {
    const message = tlsFailureMessage(failure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), verification);

    expect(message).toContain(`not signed by the CA in ${CA_PATH} (${CA_LABEL})`);
  });

  it("givenChainErrorWithoutCaFile_whenWorded_thenSuggestsChoosingOne", () => {
    const message = tlsFailureMessage(failure("SELF_SIGNED_CERT_IN_CHAIN"), { ...verification, caPath: null });

    expect(message).toContain("not signed by a CA this system trusts");
    expect(message).toContain(`as the ${CA_LABEL}`);
  });

  it("givenExpiredCertificate_whenWorded_thenSaysValidityDates", () => {
    expect(tlsFailureMessage(failure("CERT_HAS_EXPIRED"), verification)).toContain("validity dates");
  });

  it("givenChainErrorWhoseCodeTheDriverReplaced_whenWorded_thenRecognisedByMessage", () => {
    const openSsl = failure("HANDSHAKE_SSL_ERROR", "self-signed certificate in certificate chain");
    const boringSsl = failure("HANDSHAKE_SSL_ERROR", "self signed certificate in certificate chain");

    expect(tlsFailureMessage(openSsl, verification)).toContain(`not signed by the CA in ${CA_PATH}`);
    expect(tlsFailureMessage(boringSsl, verification)).toContain(`not signed by the CA in ${CA_PATH}`);
  });

  it("givenHostErrorWhoseCodeTheDriverReplaced_whenWorded_thenRecognisedByItsFields", () => {
    const error = Object.assign(failure("HANDSHAKE_SSL_ERROR", "Hostname/IP does not match"), {
      reason: "Host: db. is not in the cert's altnames",
      host: "db",
      cert: {},
    });

    expect(tlsFailureMessage(error, verification)).toContain("not valid for host db.example.com");
  });

  it("givenOtherError_whenWorded_thenNull", () => {
    expect(tlsFailureMessage(failure("ECONNREFUSED"), verification)).toBeNull();
    expect(tlsFailureMessage(new Error("no code"), verification)).toBeNull();
    expect(tlsFailureMessage("text", verification)).toBeNull();
  });
});

describe("tlsFileMessage", () => {
  it("givenMissingFile_whenWorded_thenNamesFieldPathAndReason", () => {
    expect(tlsFileMessage("Client key", "/certs/client.key", failure("ENOENT"))).toBe(
      "Cannot read the Client key /certs/client.key: the file does not exist.",
    );
  });

  it("givenFolder_whenWorded_thenSaysItIsAFolder", () => {
    expect(tlsFileMessage(CA_LABEL, "/certs", failure("EISDIR"))).toContain("it is a folder, not a file");
  });

  it("givenUnknownCode_whenWorded_thenKeepsMessage", () => {
    expect(tlsFileMessage(CA_LABEL, CA_PATH, failure("EIO", "i/o error"))).toContain("i/o error");
  });
});

describe("tlsKeyMessage", () => {
  it("givenBadDecrypt_whenWorded_thenSaysPassphrase", () => {
    expect(tlsKeyMessage("Client key", "/certs/client.key", failure("ERR_OSSL_BAD_DECRYPT"))).toBe(
      "Cannot decrypt the Client key /certs/client.key: the passphrase is wrong or missing.",
    );
  });

  it("givenEncryptedKeyWithAnyFailure_whenWorded_thenSaysPassphrase", () => {
    const interrupted = failure("ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED", "interrupted or cancelled");

    expect(tlsKeyMessage("Client key", "/k", interrupted, true)).toContain("the passphrase is wrong or missing");
  });

  it("givenMalformedKey_whenWorded_thenKeepsReason", () => {
    const message = tlsKeyMessage("Client key", "/certs/client.key", failure("ERR_OSSL_UNSUPPORTED", "unsupported"));

    expect(message).toBe("Cannot use the Client key /certs/client.key: unsupported.");
  });
});

describe("tlsKeyIsEncrypted", () => {
  it("givenEncryptedPemKeys_whenChecked_thenTrue", () => {
    expect(tlsKeyIsEncrypted("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMII")).toBe(true);
    expect(tlsKeyIsEncrypted("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: x")).toBe(true);
  });

  it("givenPlainKey_whenChecked_thenFalse", () => {
    expect(tlsKeyIsEncrypted("-----BEGIN PRIVATE KEY-----\nMII")).toBe(false);
  });
});

describe("isTlsSettingsError", () => {
  it("givenTlsSettingsError_whenChecked_thenIsAConnectionFailedPluginError", () => {
    const error = new TlsSettingsError("Cannot read the Client key /k.pem: the file does not exist.");

    expect(isPluginError(error)).toBe(true);
    expect(error.code).toBe("connectionFailed");
    expect(isTlsSettingsError(error)).toBe(true);
  });

  it("givenPlainConnectionFailed_whenChecked_thenNotTlsSettings", () => {
    expect(isTlsSettingsError(new PluginError("connectionFailed", "refused"))).toBe(false);
  });
});
