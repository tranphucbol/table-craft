/** A status popover's width: the toolbar and status bar popovers share it. */
export const POPOVER_PANEL = "flex min-h-0 w-status-popover max-w-full min-w-0 flex-col";
/** A popover's title row, ruled off from what follows. */
export const POPOVER_HEADER = "flex shrink-0 items-center gap-gap border-b border-line px-gap py-cell font-semibold";
/** A popover's content: sections a gap apart, scrolling when they outgrow the popover. */
export const POPOVER_BODY = "flex min-h-0 min-w-0 flex-col gap-gap overflow-y-auto p-gap";
/** A popover's actions, ruled off below its content. */
export const POPOVER_FOOTER = "flex shrink-0 flex-wrap items-center gap-1 border-t border-line px-gap py-cell";
