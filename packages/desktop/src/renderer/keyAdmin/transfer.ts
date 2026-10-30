import type { KeyRange, KeyTransferPolicy } from "@table-craft/desktop/engine/protocol.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { adminHost } from "./host.js";
import { useKeyAdmin } from "./store.js";

export async function transferDialog(
  datasourceId: string,
  kind: "import" | "export",
  database: number,
  range: KeyRange,
): Promise<void> {
  const modal = useModal.getState();
  if (
    kind === "export" &&
    (await modal.ask({
      kind: "confirm",
      title: "Export key range",
      message:
        "The export reads at one pinned revision. The versioned JSON format preserves binary keys and values, cluster and namespace metadata, and exported revisions. It is a namespace export, not a full cluster snapshot. Keep the file private.",
      confirm: "Choose Export File",
    })) === null
  )
    return;
  const fileGrantId = await adminHost().chooseFile(
    datasourceId,
    kind === "import" ? "transfer.import" : "transfer.export",
  );
  if (fileGrantId === null) return;
  const store = useKeyAdmin.getState();
  if (kind === "export") await store.call(datasourceId, "keyTransfer.exportStart", { fileGrantId, database, range });
  else {
    const preview = await store.call(datasourceId, "keyTransfer.previewImport", { fileGrantId, database, range });
    const policy = await modal.ask({
      kind: "choice",
      title: "Inspect key import",
      message: `${preview.newKeys} new · ${preview.changedKeys} changed · ${preview.sameKeys} unchanged · ${preview.conflicts} conflicts. Binary keys and values are preserved. Writes use bounded transactions of up to 128 operations; each transaction is all-or-nothing, the import as a whole is not. Existing leases and ownership are not restored. On an uncertain result, inspect before resuming.`,
      choices: [
        { id: "skipExisting", label: "Skip Existing", variant: "primary" },
        { id: "overwrite", label: "Overwrite", variant: "danger" },
        { id: "ifUnchanged", label: "Only If Unchanged Since Export" },
      ],
    });
    if (policy === null) return;
    if (
      policy !== "skipExisting" &&
      (await modal.ask({
        kind: "confirm",
        title: "Apply key import?",
        message:
          "Changes are committed chunk by chunk, not as one transaction. A failure can leave earlier chunks committed. No automatic retry will be made for an uncertain outcome.",
        confirm: "Start Import",
        destructive: true,
      })) === null
    )
      return;
    await store.call(datasourceId, "keyTransfer.importStart", {
      fileGrantId,
      database,
      range,
      policy: policy as KeyTransferPolicy,
    });
  }
  await store.tasks(datasourceId);
  useLayout.getState().show("services");
}
