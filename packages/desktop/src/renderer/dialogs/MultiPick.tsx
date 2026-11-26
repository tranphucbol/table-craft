import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  multiPickAnswer,
  useModal,
  type ModalRequest,
  type PickItem,
} from "@table-craft/desktop/renderer/state/modal.js";

type MultiPickRequest = Extract<ModalRequest, { kind: "multiPick" }>;

function matches(item: PickItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return needle === "" || `${item.label} ${item.detail}`.toLocaleLowerCase().includes(needle);
}

/** Searchable checklist for choosing which table rows a copy operation transfers. */
export function MultiPick({ request }: { readonly request: MultiPickRequest }) {
  const answer = useModal((state) => state.answer);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set(request.selected));
  const visible = useMemo(() => request.items.filter((item) => matches(item, query)), [request.items, query]);

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectVisible(checked: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of visible) {
        if (checked) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }

  return (
    <form
      className="flex max-h-[80vh] min-h-0 flex-col gap-gap"
      onSubmit={(event) => {
        event.preventDefault();
        answer(multiPickAnswer(request.items.filter(({ id }) => selected.has(id)).map(({ id }) => id)));
      }}
    >
      <Dialog.Title className="font-semibold wrap-anywhere">{request.title}</Dialog.Title>
      <label className="flex flex-col gap-1">
        <span className="text-ink-muted">{request.searchLabel}</span>
        <TextInput aria-label={request.searchLabel} value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="flex items-center justify-between gap-2 text-ink-muted">
        <span>{selected.size} selected</span>
        <div className="flex gap-2">
          <Button type="button" onClick={() => selectVisible(true)} disabled={visible.length === 0}>
            Select visible
          </Button>
          <Button type="button" onClick={() => selectVisible(false)} disabled={visible.length === 0}>
            Clear visible
          </Button>
        </div>
      </div>
      <ul className="flex min-h-0 flex-col gap-1 overflow-auto rounded border border-line bg-canvas p-cell">
        {visible.length === 0 ? (
          <li className="p-2 text-ink-muted">{request.empty}</li>
        ) : (
          visible.map((item) => (
            <li key={item.id}>
              <label className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-hover">
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                  className="mt-1 accent-accent"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="wrap-anywhere">{item.label}</span>
                  {item.detail === "" ? null : <span className="text-ink-muted">{item.detail}</span>}
                </span>
              </label>
            </li>
          ))
        )}
      </ul>
      <div className="flex justify-end gap-gap">
        <Button type="button" onClick={() => answer(null)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          {request.confirm}
        </Button>
      </div>
    </form>
  );
}
