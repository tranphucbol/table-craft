import { create } from "zustand";
import type { HostKeyPrompt } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";

export interface HostKeyPromptState {
  /** Unknown host keys main is waiting on, oldest first; the dialog shows the first. */
  readonly queue: readonly HostKeyPrompt[];
  readonly ask: (prompt: HostKeyPrompt) => void;
  /** Sends the ruling to main and shows the next key, if any. */
  readonly answer: (requestId: number, trust: boolean) => void;
}

export function createHostKeyPromptStore(respond: (requestId: number, trust: boolean) => void) {
  return create<HostKeyPromptState>()((set, get) => ({
    queue: [],
    ask(prompt) {
      set({ queue: [...get().queue, prompt] });
    },
    answer(requestId, trust) {
      const { queue } = get();
      if (!queue.some((prompt) => prompt.requestId === requestId)) return;
      set({ queue: queue.filter((prompt) => prompt.requestId !== requestId) });
      respond(requestId, trust);
    },
  }));
}

/** Asks whether to trust an SSH server's key the first time a tunnel meets it (decision 071). */
export const useHostKeyPrompt = createHostKeyPromptStore((requestId, trust) => {
  void bridge().answerHostKey(requestId, trust);
});

export function installHostKeyPrompts(): () => void {
  return bridge().onHostKeyPrompt((prompt) => useHostKeyPrompt.getState().ask(prompt));
}
