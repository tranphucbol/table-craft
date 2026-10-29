# Plan template

Copy this file to `docs/plans/NNN-<feature>.md` and replace every _italic guidance line_. Delete
sections that genuinely do not apply — an empty heading is worse than no heading.

Rules the existing plans follow, and this one should too:

- **Point at code.** Every claim about current behaviour cites `file.ts:line`. A plan that says
  "the explorer ignores views" without a line number cannot be checked. The cites come from one
  `explore` subagent's map (the brief in `AGENTS.md`), not from paging through files.
- **Decide, don't survey.** The Decisions table holds rulings, not options. If a choice is still
  open, the plan is not ready.
- **Name the consequences.** Anything that changes existing behaviour, weakens a guarantee, changes
  the plugin contract, or was chosen without asking gets called out by name before the phases
  start.
- **Phases land green.** Each phase is independently shippable with `bun run typecheck` and
  `bun run test` clean. A phase that only adds a field nothing reads belongs in the phase that
  reads it.
- **Write the test names.** Listing the `givenX_whenY_thenZ` cases up front is the cheapest
  scope check there is.
- **Keep it honest after the fact.** Update `Status:` and append the deviations when the work
  lands. The plan is a record, not a pitch.

---

# Plan: _short imperative title_

Status: _`not started` / `in progress` / `done`. When done, one paragraph on how reality
differed from the sketch — signature changes, files that moved, docs that live elsewhere.
Details go in "Deviations taken while implementing"; this is the headline._

## The issue

_Two or three paragraphs. What does the app do today, what does it fail to do, and how does that
failure present to the user? Prefer the observable symptom ("a `jsonb` column shows `[object
Object]` in the grid") over the abstract gap._

_If a real database, schema or query drives this, name it. A plan grounded in a concrete case is
much harder to over-build._

## Why nothing happens today

_Only when the feature "already looks configured but silently does nothing". For a green-field
addition, skip this section — the intro paragraph is enough._

| #   | Cause                                     |
| --- | ----------------------------------------- |
| 1   | _`fn()` (`src/x.ts:30`) does A but not B_ |
| 2   | _..._                                     |

_Then any adjacent facts that shape the design but are not themselves causes._

## Decisions

| #   | Decision                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | _One ruling per row. Present tense, stated as the new behaviour, with the reason attached when it is not obvious: "…— matches DataGrip"_ |
| 2   | _..._                                                                                                                                    |

_A ruling that a future reader would reopen also gets a record in `docs/decisions/`._

### Consequences worth naming

_A short bolded lead-in per consequence, then the explanation._

**_This is a behaviour change._** _What used to happen, what will happen, who it breaks, and
what the escape hatch is._

**_This changes the plugin contract._** _What moves in `@table-craft/plugin-api`, and why it
only adds (decision 106): new members optional, new contract tests gated, no new value in a
host→plugin enum without an opt-in. The `API_VERSION` minor it takes, only when `bun run
api:check` reports an addition since the last release tag and main does not already hold that
minor; never a major without the user. Existing plugins must keep loading, and the frozen plugin
must keep passing._

**_This crosses the fence._** _Which messages `engine/protocol.ts` gains, in which direction._

**_This default was chosen without asking._** _State it so the reader can object._

---

## Phase 0 — _the smallest change that unblocks the rest_

_Per file, bullets of what changes. New modules get their exported signature inline:_

```ts
export function doTheThing(options: { … }): { … };
```

- _Behaviour bullets: what it replaces, what happens on the empty case, which typed error is
  raised and what it tells the user to do._
- _Module-scope constants instead of literals, per `AGENTS.md`:_

```ts
const RESULT_WINDOW_ROWS = 500;
```

_Where several files each get one job, a table reads better than prose:_

| File              | Responsibility                                |
| ----------------- | --------------------------------------------- |
| `src/x/target.ts` | _one sentence, plus the failure mode it owns_ |

_Where behaviour has cases, tabulate them — this is also the test matrix:_

| Situation | Result          |
| --------- | --------------- |
| _..._     | _warning, skip_ |

## Phase 1 — _..._

## Phase _n_ — Fixtures, tests, docs

_Always the last phase._

_Say which changes touch the shared fixture schema the contract suite asserts against, and confirm
they are made in every dialect's seed. A change only one dialect can express is gated on a
capability, not special-cased._

Fixture schema:

- _table or column added, in which seeds, and which assertions it affects_

New `test/<area>.test.ts` for _the pure units_.

New cases:

`givenX_whenY_thenZ`,
`given…`.

_Docs: which section of `docs/design/specification.md`, which `docs/guide/` page or which decision
record gains what. Name the section, not just the file._

Every phase ends with `bun run typecheck` and `bun run test` both green; a phase touching a plugin
also runs `bun run test:db`.

---

## Live test

_Filled in by whoever implements the plan (decision 016). Build the app, drive it with Playwright
(`playwright-core` `_electron`, as `test/e2e/` does), and exercise every user-visible behaviour the
plan adds against every database it touches. Run it in the headless box
(`bun run test:smoke:db:headless`, decision 063) unless the behaviour is macOS-only, following the
`local-testing` skill. Save one PNG per behaviour to `docs/evidence/NNN/` and list them here:_

| #   | Scenario                   | Database                    | Result                               | Evidence                     |
| --- | -------------------------- | --------------------------- | ------------------------------------ | ---------------------------- |
| 1   | _what was done in the app_ | _sqlite / postgres / mysql_ | _pass, or the bug found and the fix_ | `docs/evidence/NNN/01-….png` |

_Bugs found here are fixed before the plan is marked done, each with a regression test named in
the row._

---

## Deviations taken while implementing

_Added as the work lands, numbered, each with a bolded one-line claim then the reasoning.
A deviation is not an apology — it is the reason the next reader should not "fix" the code back
to what the plan said._

**1. _What actually happened._** _Why the plan's version was wrong or unshippable._

---

## Out of scope

- _Adjacent thing a reader will assume is included, and the one-line reason it is not._
