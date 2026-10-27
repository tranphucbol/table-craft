import { create } from "zustand";
import type { InvokeResult, TableCraftBridge } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

type SnippetsBridge = Pick<
  TableCraftBridge,
  "readSnippets" | "saveSnippet" | "deleteSnippet" | "importSnippets" | "exportSnippets" | "onSnippetsChanged"
>;

export interface SnippetsState {
  readonly snippets: readonly TextSnippet[];
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  load(): Promise<void>;
  save(snippet: TextSnippet): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  importSnippets(): Promise<boolean>;
  exportSnippets(): Promise<boolean>;
  dismissError(): void;
  changed(snippets: readonly TextSnippet[]): void;
}

export interface SnippetsStoreOptions {
  readonly bridge: () => SnippetsBridge;
}

export function createSnippetsStore(options: SnippetsStoreOptions) {
  return create<SnippetsState>()((set, get) => {
    let revision = 0;
    let pending = 0;
    let queue: Promise<unknown> = Promise.resolve();
    let loading: Promise<void> | null = null;

    function mutate(run: () => Promise<InvokeResult<readonly TextSnippet[]>>): Promise<boolean> {
      if (!get().loaded) {
        set({
          error: get().error ?? "Load snippets successfully before making changes. Retry loading the snippets.",
        });
        return Promise.resolve(false);
      }
      return call(run);
    }

    function call(run: () => Promise<InvokeResult<readonly TextSnippet[]>>): Promise<boolean> {
      pending += 1;
      set({ busy: true });
      const operation = queue.then(async () => {
        const started = revision;
        try {
          const answer = await run();
          if (!answer.ok) {
            set({ error: `${answer.error.message} ${answer.error.hint}` });
            return false;
          }
          if (started === revision) set({ snippets: answer.value });
          set({ error: null, loaded: true });
          return true;
        } catch (cause) {
          set({
            error: `Could not access snippets: ${cause instanceof Error ? cause.message : String(cause)}. Try again.`,
          });
          return false;
        } finally {
          pending -= 1;
          set({ busy: pending > 0 });
        }
      });
      queue = operation;
      return operation;
    }

    return {
      snippets: [],
      loaded: false,
      busy: false,
      error: null,
      load() {
        if (loading !== null) return loading;
        loading = call(() => options.bridge().readSnippets()).then(() => {
          loading = null;
        });
        return loading;
      },
      save: (snippet) => mutate(() => options.bridge().saveSnippet(snippet)),
      remove: (id) => mutate(() => options.bridge().deleteSnippet(id)),
      importSnippets: () => mutate(() => options.bridge().importSnippets()),
      exportSnippets: async () => {
        if (!get().loaded) {
          set({
            error: get().error ?? "Load snippets successfully before making changes. Retry loading the snippets.",
          });
          return false;
        }
        pending += 1;
        set({ busy: true });
        try {
          const answer = await options.bridge().exportSnippets(get().snippets);
          if (!answer.ok) {
            set({ error: `${answer.error.message} ${answer.error.hint}` });
            return false;
          }
          set({ error: null });
          return true;
        } catch (cause) {
          set({
            error: `Could not access snippets: ${cause instanceof Error ? cause.message : String(cause)}. Try again.`,
          });
          return false;
        } finally {
          pending -= 1;
          set({ busy: pending > 0 });
        }
      },
      dismissError: () => set({ error: null }),
      changed(snippets) {
        revision += 1;
        set({ snippets, loaded: true });
      },
    };
  });
}

export type SnippetsStore = ReturnType<typeof createSnippetsStore>;
export const useSnippets = createSnippetsStore({ bridge });

export function installSnippetsSync(store: SnippetsStore = useSnippets, source: SnippetsBridge = bridge()): () => void {
  return source.onSnippetsChanged((snippets) => store.getState().changed(snippets));
}
