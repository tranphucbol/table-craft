import { useEffect } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { NODE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/nodeActions.js";
import { Select } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { runOnChoices } from "@table-craft/desktop/renderer/model/runOn.js";
import type { ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import { useServer } from "@table-craft/desktop/renderer/state/server.js";

const RUN_ON_LABEL = "Run on";

/** The console's Run on picker (decision 114), drawn once the datasource lists more than one node. */
export function RunOnPicker({ session }: { readonly session: ConsoleSession }) {
  const nodes = useServer((state) => state.nodes[session.datasourceId]);
  const ready = session.sessionId !== null;
  useEffect(() => {
    if (ready) void useServer.getState().loadNodes(session.datasourceId);
  }, [ready, session.datasourceId]);
  const choices = runOnChoices(nodes ?? []);
  if (choices.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-cell text-ink-muted">
      {RUN_ON_LABEL}
      <Select
        label={RUN_ON_LABEL}
        testId="run-on"
        value={session.node}
        options={choices}
        onChange={(node) => void invoke(NODE_ACTION_IDS.runOn, { node })}
      />
    </span>
  );
}
