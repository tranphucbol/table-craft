import { describe, expect, it } from "vitest";
import { applyPlan, planText } from "@table-craft/plugin-etcd/writes";
import {
  decodeCursor,
  encodeCursor,
  globMatches,
  literalPrefix,
  NO_END,
  prefixEnd,
} from "@table-craft/plugin-etcd/scan";
import { nodesOf } from "@table-craft/plugin-etcd/server";

const text = (value: string) => ({ text: value, hex: null });

describe("etcd scan", () => {
  it("givenPrefixes_whenEnded_thenNextKeyAfterAll", () => {
    expect(prefixEnd(Buffer.from("/app"))).toEqual(Buffer.from("/apq"));
    expect(prefixEnd(Buffer.from([0x61, 0xff]))).toEqual(Buffer.from([0x62]));
    expect(prefixEnd(Buffer.from([0xff, 0xff]))).toEqual(NO_END);
  });

  it("givenGlob_whenPrefixed_thenLiteralPartUnescaped", () => {
    expect(literalPrefix("/app/*")).toEqual(Buffer.from("/app/"));
    expect(literalPrefix("a\\*b?c")).toEqual(Buffer.from("a*b"));
    expect(literalPrefix("*")).toEqual(Buffer.alloc(0));
  });

  it("givenGlobs_whenMatchedOnBytes_thenRedisSemantics", () => {
    const key = Buffer.from("/app/config/db");
    expect(globMatches("*", Buffer.from([0xff]))).toBe(true);
    expect(globMatches("/app/*/db", key)).toBe(true);
    expect(globMatches("/app/?onfig/*", key)).toBe(true);
    expect(globMatches("/app/[a-c]onfig/db", key)).toBe(true);
    expect(globMatches("/app/[^c]onfig/db", key)).toBe(false);
    expect(globMatches("/app/\\*", Buffer.from("/app/*"))).toBe(true);
    expect(globMatches("/app/\\*", key)).toBe(false);
  });

  it("givenLastKey_whenCursorRoundTrips_thenResumesJustAfterIt", () => {
    const cursor = encodeCursor("42", Buffer.from([0x61, 0xff]));
    expect(cursor).toBe("42:61ff00");
    expect(decodeCursor(cursor)).toEqual({ revision: "42", from: Buffer.from([0x61, 0xff, 0x00]) });
    expect(decodeCursor("0")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(() => decodeCursor("nope")).toThrow(/Rescan the keys/);
  });
});

describe("etcd writes", () => {
  it("givenGuardedEdit_whenPlanned_thenValueCompareAndLeaseKept", () => {
    const plan = applyPlan(
      text("k"),
      [{ kind: "setString", value: text("new"), original: text("old") }],
      {
        type: "string",
        guard: true,
      },
      null,
    );
    expect(plan.request.compare?.[0]).toMatchObject({ target: "Value", result: "Equal", value: Buffer.from("old") });
    expect(plan.request.success?.[0]?.request_put).toMatchObject({ ignore_lease: true, value: Buffer.from("new") });
    expect(plan.request.failure?.[0]?.request_range).toMatchObject({ key: Buffer.from("k") });
    expect(planText(plan)).toEqual(['txn\nif: value("k") = old\nthen: put k new --ignore-lease\nelse: get k\nend']);
  });

  it("givenNewKeyWithTtl_whenPreviewed_thenLeaseGrantFirst", () => {
    const plan = applyPlan(
      text("k"),
      [{ kind: "setString", value: text("v"), original: null }],
      {
        type: "string",
        guard: true,
        ttlMs: 1500,
      },
      null,
    );
    expect(planText(plan)).toEqual([
      "lease grant 2",
      'txn\nif: create("k") = 0\nthen: put k v --lease=<new lease>\nelse: get k\nend',
    ]);
  });

  it("givenFieldChange_whenPlanned_thenRefusedOneValue", () => {
    expect(() =>
      applyPlan(text("k"), [{ kind: "push", value: text("x") }], { type: "string", guard: false }, null),
    ).toThrow(/etcd keys hold one value/);
  });
});

describe("etcd nodes", () => {
  it("givenMembersAndLeader_whenNoded_thenLeaderPrimaryFirst", () => {
    const member = (id: string, name: string, isLearner = false) => ({
      ID: id,
      name,
      peerURLs: [],
      clientURLs: name === "" ? [] : [`http://${name}:2379`],
      isLearner,
    });
    const nodes = nodesOf(
      [member("1", "a"), member("255", "b"), member("3", "", false), member("4", "d", true)],
      "255",
    );
    expect(nodes.map((node) => [node.id, node.role, node.state, node.primaryId])).toEqual([
      ["ff", "primary", "started", null],
      ["1", "replica", "started", "ff"],
      ["3", "replica", "unstarted", "ff"],
      ["4", "replica", "learner", "ff"],
    ]);
    expect(nodes[0]?.address).toBe("b:2379");
  });
});
