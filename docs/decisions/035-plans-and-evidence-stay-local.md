# 035: Plans and evidence stay local

Status: Accepted. Supersedes [016](016-plans-and-evidence-are-tracked.md)

## Decision

`docs/plans/NNN-*.md` and `docs/evidence/` are ignored by git. Only `docs/plans/TEMPLATE.md` stays
tracked. Plans are still written from the template, still end with a Live test section, and
screenshots are still captured into `docs/evidence/NNN/` with `TABLE_CRAFT_EVIDENCE_DIR`; they live
in the working tree, not in the repository.

## Rationale

The plans and screenshots are working material for the sessions that write and implement them.
What outlives a plan is already tracked elsewhere: the decision in `docs/decisions/`, the behaviour
in `docs/design/`, and the tests. Keeping them out of git stops the repository growing with every
plan's PNGs.

## Consequences

- Plans 001 to 015 and their evidence remain in git history up to the commit that untracked them.
- A plan written in one checkout is not visible in another clone; hand it over through the session
  that implements it.
- A plan is still done only when its Live test section is filled in.

## Amendment: the must-have roadmap is tracked

`docs/plans/ROADMAP-must-have.md` is tracked so the tracks, reserved branches, decisions and ports,
and the dispatch and merge logs of the plans in [069](069-the-must-have-release-amends-the-v1-scope.md)
are visible from any clone. The plans it names and their evidence stay local.
