import type {
  Capability,
  LanguageCapability,
  LanguageServices,
  Session,
  SessionCapability,
  SessionServices,
  SqlLanguage,
} from "@table-craft/plugin-api";
import { BUG_HINT, EngineFailure } from "@table-craft/desktop/engine/failures.js";

/** The one failure for a request whose capability this datasource's plugin does not declare (decision 155). */
export function notDeclared(capability: Capability): EngineFailure {
  return new EngineFailure({
    code: "invalidRequest",
    message: `This datasource's plugin does not declare the ${capability} capability.`,
    hint: BUG_HINT,
  });
}

/** `capability`'s service on this session; throws `notDeclared` when the plugin does not declare it. */
export function serviceOf<C extends SessionCapability>(session: Session, capability: C): SessionServices[C] {
  const service = session.services[capability];
  if (service === undefined) throw notDeclared(capability);
  return service;
}

/** Narrows `session` to one that has `capability`'s service. */
export function hasService<C extends SessionCapability>(
  session: Session,
  capability: C,
): session is Session & { readonly services: Pick<SessionServices, C> } {
  return session.services[capability] !== undefined;
}

/** `capability`'s service on this language; throws `notDeclared` when the plugin does not declare it. */
export function languageServiceOf<C extends LanguageCapability>(
  language: SqlLanguage,
  capability: C,
): LanguageServices[C] {
  const service = language.services[capability];
  if (service === undefined) throw notDeclared(capability);
  return service;
}

/** Whether this language has `capability`'s service. */
export function hasLanguageService(language: SqlLanguage, capability: LanguageCapability): boolean {
  return language.services[capability] !== undefined;
}

/** Whether a transaction is open on `session`; never one without the `transactions` service. */
export function inTransaction(session: Session): boolean {
  return hasService(session, "transactions") && serviceOf(session, "transactions").open;
}
