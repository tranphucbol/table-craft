# 121: Editor groups move tabs without duplicating sessions

Status: Accepted

## Decision

The editor has at most two horizontal groups, left and right, each with one selected tab. Split
Left and Split Right move a tab to that side; dragging uses those same registered actions. With
two groups already present, the actions move into the existing group rather than adding a third.
An empty group disappears; Unsplit joins both groups and keeps the focused tab selected.

The flat list of tabs remains the ownership list. Group membership and per-group selections are
renderer layout state. The globally active tab is the selected tab in the last focused group,
so existing actions, status items and session ownership keep their contract. Visible controls
calculate availability for their own tab; pointer and keyboard focus select their group before
invocation. Bulk closes and tab cycling operate within the targeted group.

Saved console/table descriptors add optional group membership and group-selection fields. The
existing layout document also stores the horizontal divider percentage. Old documents retain the
single-group behavior. Non-persisted tab kinds retain their existing restore policy.

## Rationale

Comparing queries and results needs two simultaneous consoles, not another view over a newly
opened session. Moving the tab preserves its console id, execution, results, transaction and
pending edits without changing engine messages or the plugin contract. Two bounded groups meet
the comparison use case without introducing a recursive docking workspace.

## Consequences

- A split needs at least two tabs; it does not clone the only console.
- Left/right drag previews show the destination before committing the move.
- Each group retains its own scrollable strip and toolbar. The divider is keyboard accessible;
  each group keeps at least 25% of the editor width.
- The SQL editor/results vertical split remains independent of this horizontal grouping.
- This changes bulk-close scope from the whole editor to the targeted group once split.
- No process, engine protocol, plugin contract or on-disk SQL format changes.
