import { StateEffect, type Extension, type Text } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { CurrentNamespace, EngineCalls, Problem } from "@table-craft/desktop/engine/protocol.js";
import { problemsIn, setProblems } from "@table-craft/desktop/renderer/console/inspections.js";
import {
  capabilitiesOf,
  connectionOf,
  datasourceById,
  useDatasources,
} from "@table-craft/desktop/renderer/state/datasources.js";
import type { InspectionSettings } from "@table-craft/desktop/settings/settings.js";

/** How long typing rests before the console asks for problems (plan 108 decision 3). */
export const INSPECTION_TYPING_DELAY_MS = 400;
/** A longer console, a pasted dump, is not inspected: every keystroke would re-check all of it. */
export const INSPECTION_MAX_TEXT = 200_000;
/** Inspecting goes through the plugin's SQL language, so a plugin without one has nothing to ask. */
/** The console languages whose plugins inspect: SQL, and a store's commands (decision 112). */
const INSPECTED_CAPABILITIES = ["sql", "commands"] as const;

export type InspectParams = EngineCalls["inspection.inspect"]["params"];
export type InspectCall = (params: InspectParams) => Promise<readonly Problem[]>;

export interface InspectionTarget {
  /** The engine to ask, or null while the datasource is not connected: inspecting never connects. */
  readonly engine: () => InspectCall | null;
  /** The console's namespace, which unqualified names resolve in; null for the catalog's. */
  readonly current: () => CurrentNamespace;
  readonly settings: () => InspectionSettings;
}

/** Asks again now, for what changed outside the text: a connection, the namespace, the settings. */
export const refreshInspections = StateEffect.define<null>();

/** What to ask for `text`, or null when nothing should be asked and the editor shows no problems. */
export function inspectionRequest(
  text: string,
  current: CurrentNamespace,
  settings: InspectionSettings,
): InspectParams | null {
  if (!settings.enabled || text.length > INSPECTION_MAX_TEXT || text.trim() === "") return null;
  return {
    text,
    ...(current === null ? {} : { current }),
    ...(settings.disabled.length === 0 ? {} : { disabled: settings.disabled }),
  };
}

/** The answer without the inspections the user turned off, in case an engine reports them anyway. */
export function enabledProblems(problems: readonly Problem[], disabled: readonly string[]): readonly Problem[] {
  if (disabled.length === 0) return problems;
  return problems.filter((problem) => !disabled.includes(problem.inspection));
}

class InspectionRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every request and by teardown, so an answer a newer one overtook is dropped. */
  private latest = 0;

  constructor(
    private readonly view: EditorView,
    private readonly target: InspectionTarget,
  ) {
    this.schedule();
  }

  update(update: ViewUpdate): void {
    const refresh = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(refreshInspections)),
    );
    if (update.docChanged || refresh) this.schedule();
  }

  destroy(): void {
    this.latest += 1;
    if (this.timer !== null) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, INSPECTION_TYPING_DELAY_MS);
  }

  private clear(): void {
    this.latest += 1;
    if (problemsIn(this.view.state).length > 0) this.view.dispatch({ effects: setProblems.of([]) });
  }

  private async run(): Promise<void> {
    const doc: Text = this.view.state.doc;
    const settings = this.target.settings();
    const params = inspectionRequest(doc.toString(), this.target.current(), settings);
    const call = this.target.engine();
    if (params === null || call === null) {
      this.clear();
      return;
    }
    this.latest += 1;
    const request = this.latest;
    let problems: readonly Problem[];
    try {
      problems = await call(params);
    } catch {
      problems = [];
    }
    // Offsets are into the text asked about; a newer edit schedules its own request.
    if (request !== this.latest || this.view.state.doc !== doc) return;
    this.view.dispatch({ effects: setProblems.of(enabledProblems(problems, settings.disabled)) });
  }
}

/** Asks the engine for the console's problems after typing rests, and on `refreshInspections`. */
export function inspectionSource(target: InspectionTarget): Extension {
  return ViewPlugin.define((view) => new InspectionRunner(view, target));
}

/** The datasource's engine while it is connected and its plugin speaks SQL or commands; null otherwise. */
export function connectedInspector(datasourceId: () => string | undefined): () => InspectCall | null {
  return () => {
    const id = datasourceId();
    if (id === undefined) return null;
    const datasources = useDatasources.getState();
    if (connectionOf(datasources, id).status !== "connected") return null;
    const pluginId = datasourceById(datasources, id)?.pluginId ?? "";
    const capabilities = capabilitiesOf(datasources.plugins, pluginId);
    if (!INSPECTED_CAPABILITIES.some((capability) => capabilities.includes(capability))) return null;
    return async (params) => (await datasources.connect(id)).call("inspection.inspect", params);
  };
}
