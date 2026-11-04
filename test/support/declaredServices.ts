import {
  SESSION_CAPABILITIES,
  type Capability,
  type CommandLanguage,
  type LanguageServices,
  type NamespaceSwitch,
  type Session,
  type SqlLanguage,
} from "@table-craft/plugin-api";

/**
 * `language` keeping only the services `capabilities` declare, plus `extra`: a fake that declares
 * less than the plugin it borrows from still loads and opens (decision 155).
 */
export function languageFor(
  language: SqlLanguage,
  capabilities: readonly Capability[],
  extra: Partial<LanguageServices> = {},
): SqlLanguage {
  const declared = new Set<string>(capabilities);
  const kept = Object.entries(language.services).filter(([capability]) => declared.has(capability));
  return { ...language, services: { ...Object.fromEntries(kept), ...extra } };
}

/** A switch the fakes' `USE <name>` statements answer, for fakes that declare `currentNamespace`. */
export const USE_SWITCH: NamespaceSwitch = {
  targets: "topLevel",
  transactional: false,
  statement: (path) => `USE ${path.join(".")}`,
};

/** A command language for fakes that declare `commands` but never split or complete. */
export const SILENT_COMMAND_LANGUAGE: CommandLanguage = {
  split: () => [],
  classify: () => ({ kind: "other", destructive: null }),
  complete: () => Promise.resolve({ from: 0, to: 0, items: [], validFor: null }),
};

/**
 * `session` with an empty object for every declared session service it lacks: what a test leaves
 * out it never calls, and an object still counts as present (decision 155).
 */
export function withDeclaredServices(session: Session, capabilities: readonly Capability[]): Session {
  const declared = SESSION_CAPABILITIES.filter((capability) => capabilities.includes(capability));
  const stubs = Object.fromEntries(declared.map((capability) => [capability, {}]));
  return { ...session, services: { ...stubs, ...session.services } };
}
