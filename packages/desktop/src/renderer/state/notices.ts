import { create } from "zustand";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import {
  deriveNotices,
  firstMemory,
  loadNoticeMemory,
  markRead,
  reconcileMemory,
  saveNoticeMemory,
  settleNotice,
  unreadIds,
  type Notice,
  type NoticeInput,
  type NoticeMemory,
} from "@table-craft/desktop/renderer/model/notices.js";
import { FEATURE_NOTICES } from "@table-craft/desktop/renderer/notices/features.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { memoryStorage } from "@table-craft/desktop/renderer/state/layout.js";

type NoticeStorage = Pick<Storage, "getItem" | "setItem">;

export interface NoticesState {
  readonly notices: readonly Notice[];
  readonly unread: readonly string[];
  readonly memory: NoticeMemory | null;
  readonly input: NoticeInput | null;
  readonly open: boolean;
  /** Raised whenever an unread notice appears that was not listed before; the dot replays its halo on it. */
  readonly arrival: number;
  readonly refresh: (input: NoticeInput) => void;
  readonly markRead: () => void;
  readonly dismiss: (id: string) => void;
  readonly dismissAll: () => void;
  /** The notice's action ran: it leaves the list unless it waits for the outcome, as an import does. */
  readonly ran: (id: string) => void;
  readonly setOpen: (open: boolean) => void;
}

/** The bell's notices over `storage`; the app passes `localStorage`, tests a map (plan 145). */
export function createNoticesStore(storage: NoticeStorage) {
  return create<NoticesState>()((set, get) => {
    function commit(memory: NoticeMemory, input: NoticeInput): void {
      const derived = deriveNotices(input, memory);
      const settled = get().open ? markRead(memory, derived) : memory;
      if (settled !== get().memory) saveNoticeMemory(storage, settled);
      const unread = unreadIds(derived, settled);
      const listed = new Set(get().unread);
      const arrived = unread.some((id) => !listed.has(id));
      set((state) => ({
        memory: settled,
        input,
        notices: derived,
        unread,
        arrival: arrived ? state.arrival + 1 : state.arrival,
      }));
    }

    function settle(ids: readonly string[]): void {
      const { memory, input, notices } = get();
      if (memory === null || input === null) return;
      let next = memory;
      for (const notice of notices) if (ids.includes(notice.id)) next = settleNotice(next, notice, input);
      commit(next, input);
    }

    return {
      notices: [],
      unread: [],
      memory: null,
      input: null,
      open: false,
      arrival: 0,
      refresh(input) {
        const memory = get().memory ?? loadNoticeMemory(storage) ?? firstMemory(input);
        commit(reconcileMemory(input, memory), input);
      },
      markRead() {
        const { memory, input, notices } = get();
        if (memory === null || input === null) return;
        commit(markRead(memory, notices), input);
      },
      dismiss: (id) => settle([id]),
      dismissAll: () => settle(get().notices.map((notice) => notice.id)),
      ran(id) {
        const notice = get().notices.find((candidate) => candidate.id === id);
        if (notice !== undefined && !notice.sticky) settle([id]);
      },
      setOpen(open) {
        set({ open });
        if (open) get().markRead();
      },
    };
  });
}

export const useNotices = createNoticesStore(
  typeof globalThis.localStorage === "undefined" ? memoryStorage() : globalThis.localStorage,
);

let installed = false;

/**
 * Starts the bell once the first data source list is in, so an app already imported from never
 * flashes its import notice: reads the version, follows data sources and plugins, then scans the
 * other apps once per launch. A failed scan only means no import notice.
 */
export function installNotices(): void {
  if (installed) return;
  installed = true;
  void (async () => {
    const info = await bridge().appInfo();
    const appVersion = info.ok ? info.value.version : "";
    let importSources: NoticeInput["importSources"] = null;
    const refresh = () => {
      const { datasources, plugins } = useDatasources.getState();
      useNotices.getState().refresh({ appVersion, importSources, datasources, plugins, features: FEATURE_NOTICES });
    };
    refresh();
    useDatasources.subscribe((state, previous) => {
      if (state.datasources !== previous.datasources || state.plugins !== previous.plugins) refresh();
    });
    const scan = await bridge().importScan();
    if (scan.ok) {
      importSources = scan.value;
      refresh();
    }
  })();
}
