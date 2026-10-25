import type { CellInput, KeyBytes, KeyChange, KeyType, Row, WireValue } from "@table-craft/desktop/engine/protocol.js";
import { formatCell } from "@table-craft/desktop/renderer/grid/format.js";
import type { EditBuffer } from "@table-craft/desktop/renderer/model/editBuffer.js";

/** Columns a key tab's rows never take edits in: positions, expiries and stream ids (decision 115). */
const READ_ONLY_COLUMNS: Readonly<Partial<Record<KeyType, readonly string[]>>> = {
  hash: ["ttl"],
  list: ["#"],
  zset: ["#"],
  stream: ["id"],
};

const HEX_DIGITS_PER_BYTE = 2;

export type KeyChanges = { readonly changes: readonly KeyChange[] } | { readonly problem: string };

export function keyReadOnlyColumns(type: KeyType | null, columns: readonly string[]): boolean[] {
  const fixed = type === null ? undefined : READ_ONLY_COLUMNS[type];
  return columns.map((name) => fixed?.includes(name) === true);
}

/** Whether rows of this type can be edited at all: strings edit in the value editor, the rest not. */
export function editsRows(type: KeyType | null): boolean {
  return type === "hash" || type === "list" || type === "set" || type === "zset" || type === "stream";
}

class Problem extends Error {}

function text(value: string): KeyBytes {
  return { text: value, hex: null };
}

/** A value as it was read, the bytes a guarded apply compares against. */
export function bytesOfValue(value: WireValue | undefined): KeyBytes {
  if (value === undefined || value === null) return text("");
  if (typeof value === "object" && value.kind === "bytes") {
    if (value.preview.length !== value.length * HEX_DIGITS_PER_BYTE) {
      throw new Problem("A value read only in part cannot be changed; reload the key.");
    }
    return { text: value.preview, hex: value.preview };
  }
  return text(formatCell(value));
}

function inputBytes(input: CellInput | undefined, held: WireValue | undefined): KeyBytes {
  if (input === undefined) return bytesOfValue(held);
  return input.kind === "text" ? text(input.text) : text("");
}

function scoreOf(input: CellInput | undefined, held: WireValue | undefined): number {
  const raw = input === undefined ? (held === undefined || held === null ? "0" : formatCell(held)) : input;
  const textual = typeof raw === "string" ? raw : raw.kind === "text" ? raw.text : "0";
  const score = Number(textual.trim() === "" ? "0" : textual);
  if (Number.isNaN(score)) throw new Problem(`Score ${textual} is not a number.`);
  return score;
}

function same(a: KeyBytes, b: KeyBytes): boolean {
  return a.text === b.text && a.hex === b.hex;
}

/**
 * The buffer's pending changes as changes to the key, each with the original value a guarded
 * apply checks (decision 115). `held(row)` is the row the result holds at that index.
 */
export function keyChangesOf(
  type: KeyType,
  columns: readonly string[],
  buffer: EditBuffer,
  held: (row: number) => Row | undefined,
): KeyChanges {
  const column = (name: string) => columns.indexOf(name);
  const changes: KeyChange[] = [];
  const rowOf = (row: number) => {
    const values = held(row);
    if (values === undefined) throw new Problem("A changed row is no longer loaded; reload the key.");
    return values;
  };
  try {
    for (const row of [...buffer.deletes].sort((a, b) => a - b)) {
      const values = rowOf(row);
      changes.push(...deletion(type, values, column));
    }
    for (const [row, cells] of [...buffer.updates.entries()].sort(([a], [b]) => a - b)) {
      changes.push(...update(type, rowOf(row), cells, column));
    }
    for (const inserted of buffer.inserts) changes.push(...insertion(type, inserted.values, columns));
  } catch (cause) {
    if (cause instanceof Problem) return { problem: cause.message };
    throw cause;
  }
  return { changes };
}

/**
 * The changes that write a missing key back as it was last read (decision 18 of plan 058): every
 * row as an insert, or the string's value. Stream entries get new ids.
 */
export function recreateChanges(
  type: KeyType,
  columns: readonly string[],
  rows: readonly Row[],
  value: WireValue | null,
): KeyChanges {
  try {
    if (type === "string") {
      return { changes: [{ kind: "setString", value: bytesOfValue(value ?? ""), original: null }] };
    }
    const changes = rows.flatMap((row) =>
      inserted(type, columns, (index) => {
        const cell = row[index];
        return cell === undefined || cell === null ? null : bytesOfValue(cell);
      }),
    );
    return { changes };
  } catch (cause) {
    if (cause instanceof Problem) return { problem: cause.message };
    throw cause;
  }
}

/** A string key's new value, guarded by the value it was read with. */
export function stringChanges(value: KeyBytes, read: WireValue | null): KeyChanges {
  try {
    return { changes: [{ kind: "setString", value, original: read === null ? null : bytesOfValue(read) }] };
  } catch (cause) {
    if (cause instanceof Problem) return { problem: cause.message };
    throw cause;
  }
}

type ColumnOf = (name: string) => number;

function deletion(type: KeyType, values: Row, column: ColumnOf): KeyChange[] {
  switch (type) {
    case "hash":
      return [
        {
          kind: "deleteField",
          field: bytesOfValue(values[column("field")]),
          original: bytesOfValue(values[column("value")]),
        },
      ];
    case "list":
      return [
        { kind: "deleteIndex", index: Number(values[column("#")]), original: bytesOfValue(values[column("value")]) },
      ];
    case "set":
    case "zset":
      return [{ kind: "deleteMember", member: bytesOfValue(values[column("member")]) }];
    case "stream":
      return [{ kind: "deleteEntry", id: formatCell(values[column("id")] ?? "") }];
    default:
      throw new Problem(`A ${type} key has no rows to delete.`);
  }
}

function update(type: KeyType, values: Row, cells: ReadonlyMap<number, CellInput>, column: ColumnOf): KeyChange[] {
  const cell = (name: string) => cells.get(column(name));
  switch (type) {
    case "hash": {
      const field = bytesOfValue(values[column("field")]);
      const original = bytesOfValue(values[column("value")]);
      const nextField = inputBytes(cell("field"), values[column("field")]);
      const value = inputBytes(cell("value"), values[column("value")]);
      if (same(field, nextField)) return [{ kind: "setField", field, value, original }];
      if (nextField.text === "") throw new Problem("A hash field needs a name.");
      return [
        { kind: "deleteField", field, original },
        { kind: "setField", field: nextField, value, original: null },
      ];
    }
    case "list":
      return [
        {
          kind: "setIndex",
          index: Number(values[column("#")]),
          value: inputBytes(cell("value"), values[column("value")]),
          original: bytesOfValue(values[column("value")]),
        },
      ];
    case "set": {
      const member = bytesOfValue(values[column("member")]);
      const next = inputBytes(cell("member"), values[column("member")]);
      return same(member, next)
        ? []
        : [
            { kind: "deleteMember", member },
            { kind: "addMember", member: next },
          ];
    }
    case "zset": {
      const member = bytesOfValue(values[column("member")]);
      const next = inputBytes(cell("member"), values[column("member")]);
      const original = scoreOf(undefined, values[column("score")]);
      const score = scoreOf(cell("score"), values[column("score")]);
      if (same(member, next)) return [{ kind: "setScore", member, score, original }];
      return [
        { kind: "deleteMember", member },
        { kind: "setScore", member: next, score, original: null },
      ];
    }
    case "stream":
      throw new Problem("Stream entries cannot change; delete the entry and add a new one.");
    default:
      throw new Problem(`A ${type} key has no rows to change.`);
  }
}

function insertion(type: KeyType, values: readonly CellInput[], columns: readonly string[]): KeyChange[] {
  return inserted(type, columns, (index) => {
    const input = values[index];
    return input?.kind === "text" ? text(input.text) : null;
  });
}

/** The changes that add one row; `given(column)` is what the row holds there, null for nothing. */
function inserted(type: KeyType, columns: readonly string[], given: (column: number) => KeyBytes | null): KeyChange[] {
  const named = (name: string) => given(columns.indexOf(name));
  switch (type) {
    case "hash": {
      const field = named("field");
      if (field === null || field.text === "") throw new Problem("A new hash field needs a name.");
      return [{ kind: "setField", field, value: named("value") ?? text(""), original: null }];
    }
    case "list":
      return [{ kind: "push", value: named("value") ?? text("") }];
    case "set":
    case "zset": {
      const member = named("member");
      if (member === null) throw new Problem(`A new ${type === "set" ? "set" : "sorted-set"} member needs a value.`);
      const score = named("score")?.text ?? "";
      return type === "set"
        ? [{ kind: "addMember", member }]
        : [{ kind: "setScore", member, score: scoreOf({ kind: "text", text: score }, undefined), original: null }];
    }
    case "stream": {
      const fields = columns.flatMap((name, index): (readonly [KeyBytes, KeyBytes])[] => {
        const value = given(index);
        return name === "id" || value === null ? [] : [[text(name), value]];
      });
      if (fields.length === 0) throw new Problem("A new stream entry needs at least one field.");
      return [{ kind: "addEntry", fields }];
    }
    default:
      throw new Problem(`A ${type} key takes no new rows.`);
  }
}
