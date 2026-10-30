import type { EngineOperationFiles } from "./keyOperations/files.js";

/** Only an explicit trusted-main grant lets a port obtain native file authority. */
export function filesForPort(
  ownerId: string,
  privateFiles: unknown,
  files: (ownerId: string) => EngineOperationFiles,
): EngineOperationFiles | undefined {
  return privateFiles === true ? files(ownerId) : undefined;
}
