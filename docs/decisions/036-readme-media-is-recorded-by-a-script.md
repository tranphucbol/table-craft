# 036: README media is recorded by a script

Status: Accepted

## Decision

Every GIF the README shows is produced by one gated Vitest suite, `test/readme/readme.media.test.ts`
(`bun run readme:media`), which drives the built app with the smoke harness on a demo shop
database, captures the window's web contents frame by frame over the Chrome DevTools Protocol
screencast, and turns each scenario into `docs/media/<name>.gif` with ffmpeg. The GIFs are tracked;
nothing else the suite writes is.

A unit test keeps the README honest about the code: every image and in-page link resolves, every
shortcut in its table matches the action registry, every setting in its table matches the defaults
in `packages/desktop/src/settings/settings.ts`, and the capability list matches `CAPABILITIES`.

## Rationale

Hand-recorded GIFs go stale the first time the UI changes, and re-recording fourteen of them by
hand is the kind of chore that does not happen. The smoke harness already launches the app,
seeds a profile, connects to the test databases and drives every feature; recording is the same
run at a human pace. A screencast of the web contents is the same on every machine and needs no
screen-recording permission, and the demo schema keeps test tables such as `type_probe` out of the
pictures.

## Consequences

- Re-recording after a UI change is `bun run readme:media`, which needs Docker and ffmpeg.
- The GIFs show the web contents only: the macOS traffic lights and the Windows and Linux overlay
  buttons are drawn by the system and are not in them; the main toolbar's inset where they sit is
  empty in the pictures.
- A mouse pointer and a keystroke badge are drawn by the suite into the page while it records; the
  app itself has neither.
- A README claim the unit test cannot check (a sentence about behaviour) is still checked only by
  review.
- Since decision 132 the GIFs sit in the guide pages as well as the README, and the check covers
  every user document.
