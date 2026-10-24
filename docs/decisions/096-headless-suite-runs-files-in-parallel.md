# 096: The headless suite runs files in parallel

Status: Accepted. Amends 063.

## Decision

The headless box (decision 063) runs smoke files `W` at a time, then the files that cannot share
a server one by one.

- **One display per worker.** The entrypoint starts `W` Xvfb servers, `:1` to `:W`, each with its
  own openbox; one session bus and one unlocked keyring serve them all. A worker draws on
  `:<VITEST_POOL_ID>` (`test/e2e/docker/display.ts`), so focus, keystrokes and the X clipboard
  never cross between apps running at once.
- **Two Vitest projects.** Inside the box (`TABLE_CRAFT_SMOKE=1` and `TABLE_CRAFT_HEADLESS=1`),
  `vitest.config.ts` splits the smoke files into `smoke-parallel` (group 0, `W` workers) and
  `smoke-serial` (group 1, one file at a time, after group 0 ends). `SERIAL_SMOKE_FILES` in
  `test/e2e/serialFiles.ts` lists the serial files, each with the reason it cannot share the
  server: it expects an exact table count another file's table changes, writes the shared
  `orders` and `edit_probe` rows, or kills sessions it did not open. A file that flakes beside
  others moves there with its reason; it never gets a longer timeout.
- **`W` follows the Docker VM.** `TABLE_CRAFT_SMOKE_WORKERS` sets it; unset, it is 3 when the
  Docker VM is set to 8 GiB or more and 1 below, and the runner prints the VM size, the `W` it
  chose and how to raise it (`test/e2e/docker/workers.ts`). The cut is at 7 GiB of reported
  memory, since a VM set to 8 GiB reports 7.8. The three belong to the VM, not to each run: a
  run that finds other headless boxes running takes its share (3 ÷ (others + 1), at least 1),
  since nine apps on one 8 GiB VM starve each other's CPU and swap.
- **Every worktree keeps its own stack.** A second checkout still runs its own databases on its
  own ports. Containers carry a `table-craft.seed` label, the hash of the files each was seeded
  from (`test/db/stack.ts`), so `up -d` recreates exactly the ones whose seed changed; a global
  setup checks one sentinel object per server before any file runs and names the fix when a
  container predates its seed (`test/support/smokeFixtures.ts`).
- The host's `test:smoke` and `test:smoke:db` stay serial: one display, one real clipboard.

## Rationale

The suite took 21 minutes alone, mostly one Electron app at a time waiting on a database that
idles. Files that only read the fixtures or create tables with their own names can share the
servers; most do. A per-file isolation scheme (a database per worker) would touch every fixture
reader and every plugin's default database, for the minority of files that clash; listing those
is cheaper and says why.

A shared stack across worktrees was rejected: two checkouts on different branches can seed
different schemas, and one checkout's reseed would pull the other's fixtures from under a running
suite. Separate stacks cost memory, which the smaller MySQL (a 32 MB buffer pool, no binary log,
a trimmed performance schema) mostly pays back.

## Consequences

- A suite on an 8 GiB VM runs three apps at once; on Docker Desktop's and OrbStack's 4 GiB
  default it runs one, as before, and says how to get three. Three worktrees running theirs at
  once share the three; boxes started in the same second each see none and take three, so stagger
  them or set `TABLE_CRAFT_SMOKE_WORKERS`.
- A new smoke file that counts tables, writes `orders` or `edit_probe`, or kills sessions by
  text goes into `SERIAL_SMOKE_FILES`, or names its objects and markers so it can share.
- Every global setup runs once per Vitest project in the one main process, so each must be
  idempotent (`tidbScratch.ts`, `smokeFixtures.ts` are).
- Electron fetches its binary on first use; the entrypoint fetches it once before any worker
  starts, since parallel workers race to unpack it.
