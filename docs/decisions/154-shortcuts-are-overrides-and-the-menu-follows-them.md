# 154: Shortcuts are overrides in settings.json, and the menu follows them

Status: Proposed

## Decision

A user's shortcuts are `keymap` in `settings.json`: an object from action id to the chords that
replace that action's declared one. It holds overrides only; `{}` and an absent field both mean
every default, and `[]` leaves an action without a shortcut. The registry keeps the defaults, and
`SETTINGS_VERSION` stays 1.

- Reading keeps an entry's chords that parse on both platforms and drops the rest. An entry whose
  every chord fails falls back to the default; `[]` as written stays. An id this build has no
  action for is kept on disk and ignored, so a plugin's or a later version's binding survives a
  downgrade.
- The keymap in effect is one pure function, `effectiveShortcuts(actions, overrides)`, in
  `renderer/actions/keymapOverrides.ts`. The dispatcher, `findClashes`, every label (through
  `useShortcut`), the palette and the Keymap page read it, never `Action.shortcut` directly. An
  action may hold several chords; labels show the first.
- The native menu follows it. Main rebuilds the application menu when a written `keymap` differs
  from the one the menu was built with; `menuAccelerator` spells `Mod+Shift+F` as
  `CmdOrCtrl+Shift+F`, and a double-tap or `[]` shows none. Only a menu item that declares an
  accelerator follows overrides.
- The chord spelling, `parseChord`, `menuAccelerator` and `RESERVED_CHORDS` live in the shared pure
  `settings/chords.ts`, so main, the settings reader and the renderer use one parser.
- The Keymap page records one stroke. It refuses a key without `Mod`, `Ctrl` or `Alt` other than
  F1–F24, the Super key off macOS and the chords the menu's roles or the operating system keep
  (macOS: ⌘Q, ⌘H, ⌥⌘H, ⌘M, ⌘Tab, ⌘Space, ⌘\`; elsewhere Alt+F4 and Alt+Tab), each with its
  reason. A chord another action holds where both could fire (the same rule as `findClashes`) is
  offered with Reassign, which writes that action's override without it. A chord the SQL editor
  keeps while it has focus is accepted with a note saying what the editor does with it.

## Rationale

Storing the whole keymap would freeze every default at the version that wrote it, so a later
release could not move a chord, and a file would silently keep a chord the app gave to another
action. Overrides keep the file small, readable and honest about what the user changed, and a
reset is deleting an entry.

The menu has to follow, not only for its labels: Electron's menu does not register its
accelerators globally, but on macOS a key equivalent the page does not handle still reaches the
menu, so a stale accelerator would run the action under its old chord after the user moved it.

Refusing reserved chords, rather than warning, matches what would happen: the role or the system
takes the key before the renderer sees it, so the binding could never fire. The editor's own
chords differ: the dispatcher already lets them through only while the SQL editor has focus, so a
binding on one works everywhere else and the note says so.

Keeping unknown ids makes a profile shared between versions, or with a plugin not loaded now,
lossless. Restore Defaults therefore resets only the actions this build knows.

## Consequences

- Every label site goes through `useShortcut` or `shortcutText`; a new one reading
  `Action.shortcut` directly would show a stale chord. `docs/guide/shortcuts.md` keeps listing the
  defaults, and `userDocs.test.ts` still checks them against `Action.shortcut`.
- A new action's default can be taken by a user's override on another action; the Keymap page's
  clash check only runs on recording, so the dispatcher's first match decides until the user
  reassigns.
- Chords that two platforms spell alike (`Mod` and `Ctrl` on Windows and Linux) are compared per
  platform; an override is written once and holds on both.
- Recording a two-stroke chord, importing another IDE's keymap and per-datasource keymaps are not
  part of this decision.
