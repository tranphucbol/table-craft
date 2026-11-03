import { basename } from "node:path";
import type { Logger } from "@table-craft/desktop/log/record.js";
import { DATASOURCE_FILE_NAME, writeDatasourceFile } from "@table-craft/desktop/main/datasourceFile.js";
import { DatasourceError, type DatasourceService } from "@table-craft/desktop/main/service.js";
import type {
  DatasourceSelection,
  ExportDatasourcesRequest,
  ExportDatasourcesResult,
} from "@table-craft/desktop/preload/bridge.js";

const SAVE_TITLE = "Export Data Sources";

export interface DatasourceExportOptions<Sender> {
  readonly service: Pick<DatasourceService<Sender>, "exportDefinitions">;
  readonly saveFile: (sender: Sender, title: string, defaultName: string) => Promise<string | null>;
  readonly writeText: (path: string, text: string) => Promise<void>;
  /** Counts only: never a name, a host or a secret (decision 020). */
  readonly log: Pick<Logger, "info">;
}

/** Export Data Sources and Copy behind the `datasources.export` and `datasources.copy` channels (plan 040). */
export interface DatasourceExportChannels<Sender> {
  export(sender: Sender, request: ExportDatasourcesRequest): Promise<ExportDatasourcesResult>;
  /** The selection as file text without any secret, for the clipboard. */
  copy(selection: DatasourceSelection): Promise<string>;
}

export function createDatasourceExport<Sender>(
  options: DatasourceExportOptions<Sender>,
): DatasourceExportChannels<Sender> {
  const { service, log } = options;

  function definitions(selection: DatasourceSelection, includeSecrets: boolean) {
    const content = service.exportDefinitions(selection, includeSecrets);
    if (content.datasources.length === 0 && content.folders.length === 0) {
      throw new DatasourceError("Nothing to export.", "Select saved data sources or folders in the Database pane.");
    }
    return content;
  }

  return {
    async export(sender, request) {
      const { passphrase, ...selection } = request;
      const content = definitions(selection, passphrase !== undefined);
      const path = await options.saveFile(sender, SAVE_TITLE, DATASOURCE_FILE_NAME);
      if (path === null) return { status: "cancelled" };
      const text = await writeDatasourceFile(content, passphrase);
      try {
        await options.writeText(path, text);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new DatasourceError(
          `${basename(path)} could not be written: ${reason}`,
          "Pick a folder you can write to.",
        );
      }
      log.info("datasources exported", {
        datasources: content.datasources.length,
        folders: content.folders.length,
        passwords: passphrase !== undefined,
      });
      return { status: "saved", path, count: content.datasources.length };
    },
    async copy(selection) {
      const content = definitions(selection, false);
      log.info("datasources copied", { datasources: content.datasources.length });
      return writeDatasourceFile(content);
    },
  };
}
