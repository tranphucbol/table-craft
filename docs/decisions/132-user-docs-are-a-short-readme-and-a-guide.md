# 132: User docs are a short README and a guide

Status: Accepted. Extends 036.

## Decision

User documentation is `README.md` plus one page per topic in `docs/guide/`. The README is the front
page: what TableCraft is, Highlights, Install in short, Quick start, How it works, a Documentation
index of every guide page, Not in v1, Contributing and License, in at most 200 lines. A feature is
documented in the guide page it belongs to.

`CONTRIBUTING.md` at the repository root is the contributor's on-ramp: setting up, which tests a
change needs, the rules review checks and why, and how to report a bug. It links to `AGENTS.md` for
every command and to the `local-testing` skill (decision 133) for every test server, environment
variable and port rather than copying them. `RELEASING.md` beside it is the maintainer's
checklist for a release, from choosing the version to checking what reached npm; it describes the
workflows and links decisions 044, 106, 107 and 109 rather than restating them.

One test, `test/renderer/userDocs.test.ts`, checks the README, CONTRIBUTING, RELEASING and every
guide page:
images and links resolve relative to the page that has them, as GitHub resolves them, anchors are
checked against the target page's headings, the Documentation index lists every guide page once,
and the tables are checked in the page that holds them. RELEASING's job table must list the jobs
of `ci.yml` in order, and it must name every environment and secret the workflows use. Its label
table must match `.github/release.yml`, which groups the generated release notes by pull request
label, and CONTRIBUTING and the create-pr skill must name every one of those labels. The notes
themselves are written on the release, never committed: a maintainer adds a short Highlights part
above the generated list.

Old links to README sections get no redirect anchors.

## Rationale

The README had grown to 1,077 lines with 48 headings, and every feature plan added a section.
Someone installing the app scrolled past Oracle's number padding, and a plugin author started at
line 844. Splitting by what the reader is doing keeps each page short and gives each audience its
own entry point; plugins split into a page for users and one for authors.

A docs site (VitePress, MkDocs) would add a toolchain and a deploy for what GitHub already renders.
Copying `AGENTS.md` into CONTRIBUTING would let the two drift; linking keeps one source.

Hidden `<a id>` anchors for every old README heading would be dozens of lines of noise, and GitHub
prefixes rendered ids with `user-content-`, so they do not reliably work.

## Consequences

- An external link to `README.md#<section>` opens the README at the top; the Documentation index is
  one screen down.
- The README's line budget is a constant in the test. A feature plan that wants to grow the README
  adds a Highlight at most.
- The GIFs live with their sections in the guide, as `../media/<name>.gif`; `docs/media/` and
  `bun run readme:media` keep their names (decision 036).
- The Bun version sentence that `test/desktop/toolchain.test.ts` checks is in CONTRIBUTING.
