# 120: Motion is plain CSS, and surfaces animate in only

Status: Accepted

## Decision

Every animation in the renderer is a CSS `@keyframes` in `app.css`, started by a Radix
`data-state` (and `data-side`) attribute through the class strings in `renderer/ui/motion.ts`. No
JavaScript motion library (Motion, AutoAnimate, react-spring) is used.

Popovers, context menus, tooltips, dialogs and the command palette animate when they open and
never when they close: no class matches `data-state=closed`.

Every timing is a token in `appearance/motion.ts`, written as `--tc-motion-*` variables per the
`appearance.motion` level (System, Full, Reduced, Off). Loops (`animate-spin`, `animate-pulse`)
read their `animation-play-state` from `--tc-motion-progress` and `--tc-motion-ambient`.

## Rationale

The motion wanted is small: a fade with a few pixels of travel, or a slight scale for dialogs, on
the five kinds of surface that open. That needs no springs, gestures or layout animation, and the
compositor runs a CSS animation off the main thread, whereas a JavaScript library does per-frame
work beside the virtualised grid and the editor. Radix already exposes the open state and side as
attributes, so a class is all a surface needs.

Exit animations were rejected. Radix's Presence keeps a closing element mounted until its exit
animation ends, and the focus return (`onCloseAutoFocus`) waits for that unmount. In a keyboard-
driven IDE an exit fade would put the first keystroke after Esc or Enter into the closing surface
instead of the editor. With no animation on `closed`, Presence sees none and unmounts in the same
frame.

Keeping every duration a variable lets the levels change motion live without a restart: Off zeroes
the durations and pauses the loops, Reduced keeps fades but drops travel, scale and the ambient
pulse, and System follows `prefers-reduced-motion`.

## Consequences

- Closing is instant everywhere; retuning an opening is one edit in `appearance/motion.ts`.
- Surface travel animates `transform`, not `translate`: the palette and dialogs centre themselves
  with Tailwind's `translate`, and the two properties compose. Dialogs animate only `opacity` and
  `scale`.
- A future exit animation needs a focus-safe mechanism first, such as returning focus before the
  element unmounts.
- Off pauses spinners at their first frame; each spinner already pairs with text, so status is
  still shown.
