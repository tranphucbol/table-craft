import { changeCommands, commandText } from "@table-craft/plugin-redis/apply";
import { describe, expect, it } from "vitest";

const KEY = { text: "user:42:profile", hex: null };

function text(value: string) {
  return { text: value, hex: null };
}

describe("redis key changes", () => {
  it("givenHashChanges_whenPreviewed_thenHsetAndHdel", () => {
    const commands = changeCommands(
      KEY,
      [
        { kind: "setField", field: text("name"), value: text("Ann Lee"), original: text("Ann") },
        { kind: "deleteField", field: text("email"), original: text("a@x") },
      ],
      { type: "hash", guard: true },
    );
    expect(commands.map(commandText)).toEqual(['HSET user:42:profile name "Ann Lee"', "HDEL user:42:profile email"]);
  });

  it("givenListDeletes_whenPreviewed_thenTombstonesThenOneLrem", () => {
    const commands = changeCommands(
      KEY,
      [
        { kind: "deleteIndex", index: 0, original: text("a") },
        { kind: "deleteIndex", index: 2, original: text("c") },
      ],
      { type: "list", guard: true },
      "tomb",
    );
    expect(commands.map(commandText)).toEqual([
      "LSET user:42:profile 0 tomb",
      "LSET user:42:profile 2 tomb",
      "LREM user:42:profile 0 tomb",
    ]);
  });

  it("givenSortedSetMemberDeleted_whenPreviewed_thenZrem", () => {
    const commands = changeCommands(KEY, [{ kind: "deleteMember", member: text("ann") }], {
      type: "zset",
      guard: false,
    });
    expect(commands.map(commandText)).toEqual(["ZREM user:42:profile ann"]);
  });

  it("givenNewStringWithTtl_whenPreviewed_thenSetKeepttlAndPexpire", () => {
    const commands = changeCommands(KEY, [{ kind: "setString", value: text("hi"), original: null }], {
      type: "string",
      guard: true,
      ttlMs: 60_000,
    });
    expect(commands.map(commandText)).toEqual(["SET user:42:profile hi KEEPTTL", "PEXPIRE user:42:profile 60000"]);
  });

  it("givenBinaryValue_whenPreviewed_thenQuotedLikeRedisCli", () => {
    const commands = changeCommands(KEY, [{ kind: "push", value: { text: "\\xff", hex: "ff00" } }], {
      type: "list",
      guard: false,
    });
    expect(commands.map(commandText)).toEqual(['RPUSH user:42:profile "\\xff\\x00"']);
  });
});
