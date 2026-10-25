import { asResp3, scoreOf } from "@table-craft/plugin-redis/resp2";
import { successorId } from "@table-craft/plugin-redis/read";
import { describe, expect, it } from "vitest";

function bytes(text: string): Buffer {
  return Buffer.from(text);
}

/** Decision 116: RESP2 replies of a 5.0 server in their RESP3 shape. */
describe("redis RESP2 replies", () => {
  it("givenHgetallFlatArray_whenAsResp3_thenMap", () => {
    const reply = asResp3(["HGETALL", "h"], [bytes("name"), bytes("Ann"), bytes("email"), bytes("a@x")]);
    expect(reply).toEqual(
      new Map([
        [bytes("name"), bytes("Ann")],
        [bytes("email"), bytes("a@x")],
      ]),
    );
    expect(asResp3(["config", "get", "maxmemory"], [bytes("maxmemory"), bytes("0")])).toBeInstanceOf(Map);
  });

  it("givenScoredFlatArray_whenAsResp3_thenNumberPairs", () => {
    const reply = asResp3(
      ["ZRANGE", "z", "0", "-1", "withscores"],
      [bytes("a"), bytes("1.5"), bytes("b"), bytes("inf")],
    );
    expect(reply).toEqual([
      [bytes("a"), 1.5],
      [bytes("b"), Number.POSITIVE_INFINITY],
    ]);
    expect(asResp3(["ZSCORE", "z", "a"], bytes("-inf"))).toBe(Number.NEGATIVE_INFINITY);
    expect(asResp3(["ZPOPMIN", "z"], [bytes("a"), bytes("1")])).toEqual([bytes("a"), 1]);
    expect(asResp3(["ZPOPMIN", "z", "2"], [bytes("a"), bytes("1"), bytes("b"), bytes("2")])).toEqual([
      [bytes("a"), 1],
      [bytes("b"), 2],
    ]);
    expect(asResp3(["BZPOPMIN", "z", "0"], [bytes("z"), bytes("a"), bytes("1")])).toEqual([bytes("z"), bytes("a"), 1]);
  });

  it("givenUnknownCommand_whenAsResp3_thenUnchanged", () => {
    const reply = [bytes("a"), bytes("1")];
    expect(asResp3(["LRANGE", "l", "0", "-1"], reply)).toBe(reply);
    expect(asResp3(["ZRANGE", "z", "0", "-1"], reply)).toBe(reply);
    expect(asResp3(["GET", "k"], bytes("1.5"))).toEqual(bytes("1.5"));
    expect(scoreOf(null)).toBeNull();
  });

  it("givenEmptyArray_whenAsResp3_thenEmptyMap", () => {
    expect(asResp3(["HGETALL", "missing"], [])).toEqual(new Map());
  });

  it.each([
    ["1-0", "1-1"],
    ["1700000000000-41", "1700000000000-42"],
    ["5-18446744073709551615", "6-0"],
  ])("givenStreamId%s_whenSuccessor_then%s", (id, next) => {
    expect(successorId(id)).toBe(next);
  });
});
