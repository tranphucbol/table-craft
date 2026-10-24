import { useState } from "react";
import { useModal, type ModalRequest, type PickItem } from "@table-craft/desktop/renderer/state/modal.js";
import { ListPicker } from "@table-craft/desktop/renderer/ui/ListPicker.js";

type PickRequest = Extract<ModalRequest, { kind: "pick" }>;

function matches(item: PickItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || `${item.label} ${item.detail}`.toLowerCase().includes(needle);
}

/** A searchable list answering the chosen item's id. */
export function Pick({ request }: { readonly request: PickRequest }) {
  const answer = useModal((state) => state.answer);
  const [query, setQuery] = useState("");
  const items = request.items.filter((item) => matches(item, query));
  return (
    <ListPicker
      title={request.title}
      searchLabel={request.searchLabel}
      query={query}
      onQuery={setQuery}
      items={items}
      keyOf={(item) => item.id}
      labelOf={(item) => item.label}
      renderItem={(item) => (
        <>
          <span className="shrink-0">{item.label}</span>
          <span className="truncate text-ink-muted">{item.detail}</span>
        </>
      )}
      empty={request.empty}
      preview={() => null}
      onChoose={(item) => answer(item.id)}
      buttons={[
        {
          label: request.confirm,
          variant: "primary",
          onClick: (item) => {
            if (item !== null) answer(item.id);
          },
        },
      ]}
      onClose={() => answer(null)}
    />
  );
}
