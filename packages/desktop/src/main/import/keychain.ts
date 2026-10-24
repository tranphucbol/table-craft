import { execFile } from "node:child_process";

/**
 * Looks a password up in the operating system's credential store the way IntelliJ saved it: by
 * service name (`platform/credential-store-impl/src/credentialStore/macOsKeychainLibrary.kt` and
 * `linuxSecretLibrary.kt`, Apache-2.0). It runs the system's own tool, never a shell, so the user
 * sees the system's prompt naming that tool.
 */
export type SecretLookup =
  | { readonly status: "found"; readonly value: string }
  | { readonly status: "notFound" }
  /** The user clicked Deny or Cancel; the importer asks no more. */
  | { readonly status: "denied" }
  | { readonly status: "locked"; readonly reason: string };

export interface CommandResult {
  /** Null when the command could not start or was killed. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the command could not start, such as `ENOENT`. */
  readonly startError: string | null;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export const SECURITY_TOOL = "/usr/bin/security";
export const SECRET_TOOL = "secret-tool";
/** Long enough for the user to read the system prompt and answer it. */
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** `security` exits with the low byte of the OSStatus: errSecItemNotFound -25300. */
const EXIT_NOT_FOUND = 44;
/** errSecUserCanceled -128 and errSecAuthFailed -25293. */
const EXIT_DENIED = new Set([128, 51]);
/** errSecInteractionNotAllowed -25308: the keychain is locked and may not prompt. */
const EXIT_LOCKED = 36;
/**
 * `security -g` prints the password to standard error as `password: "text"`, or as
 * `password: 0x<hex>  "<escaped>"` when any byte is not printable ASCII; `-w` prints that hex
 * bare, which cannot be told apart from a password made of hex digits.
 */
const HEX_PASSWORD = /^password: 0x([0-9A-Fa-f]*)/m;
const QUOTED_PASSWORD = /^password: "(.*)"$/m;
const EMPTY_PASSWORD = /^password:\s*$/m;
const ESCAPE = "\\";
const DELIMITER = "@";

/** Runs a program directly, without a shell, and collects its standard output. */
export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, startError: null });
          return;
        }
        const code = typeof error.code === "number" ? error.code : null;
        const startError = typeof error.code === "string" ? error.code : null;
        resolve({ code, stdout, stderr, startError });
      },
    );
  });

/**
 * IntelliJ stores `user@password` in the Secret Service, with `\` and `@` escaped in the user only
 * (`credentialStore.kt`, `joinData`/`splitData`); the password is everything after the first
 * unescaped `@`.
 */
export function splitJoinedSecret(data: string): { user: string; password: string | null } {
  let user = "";
  for (let index = 0; index < data.length; index++) {
    const char = data[index];
    if (char === ESCAPE) {
      user += data[index + 1] ?? "";
      index++;
    } else if (char === DELIMITER) {
      return { user, password: data.slice(index + 1) };
    } else {
      user += char;
    }
  }
  return { user, password: null };
}

/** The password `security find-generic-password -g` printed, or null when there is none. */
export function securityPassword(stderr: string): string | null {
  const hex = HEX_PASSWORD.exec(stderr)?.[1];
  if (hex !== undefined) return Buffer.from(hex, "hex").toString("utf8");
  const quoted = QUOTED_PASSWORD.exec(stderr)?.[1];
  if (quoted !== undefined) return quoted;
  return EMPTY_PASSWORD.test(stderr) ? "" : null;
}

export interface CredentialReader {
  readonly available: boolean;
  /** What the dialog calls the store, e.g. "macOS Keychain". */
  readonly label: string;
  lookup(service: string): Promise<SecretLookup>;
}

export interface CredentialReaderOptions {
  readonly platform: NodeJS.Platform;
  readonly run: CommandRunner;
  /** Keychain files to search instead of the default list; the tests' temporary keychain. */
  readonly keychains?: readonly string[];
}

export function createCredentialReader(options: CredentialReaderOptions): CredentialReader {
  if (options.platform === "darwin") {
    return {
      available: true,
      label: "macOS Keychain",
      async lookup(service) {
        const args = ["find-generic-password", "-s", service, "-g", ...(options.keychains ?? [])];
        const result = await options.run(SECURITY_TOOL, args);
        if (result.code === 0) {
          const value = securityPassword(result.stderr);
          return value === null ? { status: "notFound" } : { status: "found", value };
        }
        if (result.code === EXIT_NOT_FOUND) return { status: "notFound" };
        if (result.code !== null && EXIT_DENIED.has(result.code)) return { status: "denied" };
        if (result.code === EXIT_LOCKED) return { status: "locked", reason: "The keychain is locked." };
        return {
          status: "locked",
          reason: `The keychain could not be read (${result.startError ?? String(result.code)}).`,
        };
      },
    };
  }
  if (options.platform === "linux") {
    return {
      available: true,
      label: "Secret Service",
      async lookup(service) {
        const result = await options.run(SECRET_TOOL, ["lookup", "service", service]);
        if (result.startError !== null) {
          return { status: "locked", reason: "secret-tool is not installed (package libsecret-tools)." };
        }
        if (result.code !== 0 || result.stdout === "") return { status: "notFound" };
        const { password } = splitJoinedSecret(result.stdout);
        return password === null ? { status: "notFound" } : { status: "found", value: password };
      },
    };
  }
  return {
    available: false,
    label: "Windows Credential Manager",
    lookup: () =>
      Promise.resolve({ status: "locked", reason: "TableCraft cannot read Windows Credential Manager yet." }),
  };
}
