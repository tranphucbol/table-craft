import { describe, expect, it } from "vitest";
import { NODE_ALL_PRIMARIES, NODE_AUTO, type ServerNode } from "@table-craft/desktop/engine/protocol.js";
import { nextRunOn, nodeLabel, runOnChoices } from "@table-craft/desktop/renderer/model/runOn.js";

const PRIMARY: ServerNode = {
  id: "a1",
  address: "127.0.0.1:7001",
  role: "primary",
  slots: [[0, 5460]],
  primaryId: null,
  state: "connected",
};
const REPLICA: ServerNode = {
  id: "b4",
  address: "127.0.0.1:7004",
  role: "replica",
  slots: [],
  primaryId: "a1",
  state: "connected",
};

describe("run on", () => {
  it("givenOneNode_whenChoices_thenNoPicker", () => {
    expect(runOnChoices([{ ...PRIMARY, slots: [] }])).toEqual([]);
  });

  it("givenCluster_whenChoices_thenAutoAllPrimariesThenEachNode", () => {
    expect(runOnChoices([PRIMARY, REPLICA])).toEqual([
      { value: NODE_AUTO, label: "Auto" },
      { value: NODE_ALL_PRIMARIES, label: "All primaries" },
      { value: "a1", label: "127.0.0.1:7001 primary 0–5460" },
      { value: "b4", label: "127.0.0.1:7004 replica of 127.0.0.1:7001" },
    ]);
  });

  it("givenPrimaryWithReplica_whenChoices_thenAutoThenEachNodeWithoutAllPrimaries", () => {
    const primary = { ...PRIMARY, slots: [] };
    const replica = { ...REPLICA, slots: [] };
    expect(runOnChoices([primary, replica])).toEqual([
      { value: NODE_AUTO, label: "Auto" },
      { value: "a1", label: "127.0.0.1:7001 primary" },
      { value: "b4", label: "127.0.0.1:7004 replica of 127.0.0.1:7001" },
    ]);
  });

  it("givenSplitSlots_whenLabelled_thenEveryRangeListed", () => {
    expect(
      nodeLabel(
        {
          ...PRIMARY,
          slots: [
            [0, 10],
            [12, 12],
          ],
        },
        [],
      ),
    ).toBe("127.0.0.1:7001 primary 0–10, 12");
  });

  it("givenLastChoice_whenNext_thenWrapsToAuto", () => {
    const choices = runOnChoices([PRIMARY, REPLICA]);
    expect(nextRunOn(choices, NODE_AUTO)).toBe(NODE_ALL_PRIMARIES);
    expect(nextRunOn(choices, "b4")).toBe(NODE_AUTO);
    expect(nextRunOn(choices, "gone")).toBe(NODE_AUTO);
  });
});
