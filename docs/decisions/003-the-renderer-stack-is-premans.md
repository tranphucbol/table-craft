# 003: The renderer stack is preman's

Status: Accepted

## Decision

The renderer uses React 19, Zustand 5, Tailwind CSS v4, CodeMirror 6, Radix primitives,
`@tanstack/react-virtual`, `react-resizable-panels` and Phosphor icons. Each process is built by
its own Vite config. Zustand has one store per subscription surface (datasources, explorer tree,
each console, each result set) so a streaming result window re-renders the grid and nothing else.

## Rationale

This is the stack `../preman` already proved under the same three-process model, with the same
tooling, lint fences and appearance layer. Re-deciding it buys nothing; copying it means patterns,
config and fixes transfer between the two repos. Virtualization, not the framework, is what keeps
a 100k-row grid fast.

## Consequences

- When in doubt about a renderer pattern, look at how preman does it first.
- CodeMirror is the one editor everywhere: consoles, the DDL view, cell editors for long values.
- Amended by decision 157: the ER diagram adds React Flow (`@xyflow/react`) and ELK (`elkjs`).
