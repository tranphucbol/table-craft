import { describe, expect, it } from "vitest";
import type { KeyDetails } from "@table-craft/desktop/engine/protocol.js";
import {
  attributeFacts,
  attributeLabel,
  detailRows,
  keyInfoParts,
} from "@table-craft/desktop/renderer/model/keyHeader.js";
import { useKeyDetails } from "@table-craft/desktop/renderer/state/keyDetails.js";

const KEY = { text: "/config/payments/limits.json", hex: null };

const PLAIN: KeyDetails = {
  key: KEY,
  type: "string",
  typeName: "string",
  ttlMs: null,
  length: 2458,
  memoryBytes: null,
  encoding: null,
  idleSeconds: null,
};

const WITH_ATTRIBUTES: KeyDetails = {
  ...PLAIN,
  attributes: [
    { name: "create_revision", value: "48190002" },
    { name: "mod_revision", value: "48213877" },
    { name: "version", value: "14" },
    { name: "lease", value: "694d8a1c2f3e0b11" },
  ],
};

describe("key details", () => {
  it("givenSnakeCaseName_whenLabelled_thenSentenceCase", () => {
    expect(attributeLabel("create_revision")).toBe("Create revision");
    expect(attributeLabel("lease")).toBe("Lease");
    expect(attributeLabel("_")).toBe("_");
  });

  it("givenAttributesWithVersion_whenHeaderFacts_thenShortVersionAndHumanSize", () => {
    expect(attributeFacts(WITH_ATTRIBUTES)).toEqual(["v14", "2.4 KB"]);
  });

  it("givenAttributesWithoutWholeNumberVersion_whenHeaderFacts_thenSizeOnly", () => {
    const odd = { ...WITH_ATTRIBUTES, attributes: [{ name: "version", value: "beta" }] };
    expect(attributeFacts(odd)).toEqual(["2.4 KB"]);
    expect(attributeFacts({ ...PLAIN, type: "hash", length: 3, attributes: [] })).toEqual(["3 fields"]);
  });

  it("givenNoAttributes_whenHeaderFacts_thenNoneAndInfoLineUnchanged", () => {
    expect(attributeFacts(PLAIN)).toEqual([]);
    expect(keyInfoParts(PLAIN)).toEqual(["2,458 bytes"]);
  });

  it("givenAttributes_whenDetailRows_thenSizeFirstThenEveryAttributeInOrder", () => {
    expect(detailRows(WITH_ATTRIBUTES)).toEqual([
      { label: "Size", value: "2.4 KB" },
      { label: "Create revision", value: "48190002" },
      { label: "Mod revision", value: "48213877" },
      { label: "Version", value: "14" },
      { label: "Lease", value: "694d8a1c2f3e0b11" },
    ]);
  });

  it("givenUnknownLength_whenDetailRows_thenNoSizeRow", () => {
    expect(detailRows({ ...WITH_ATTRIBUTES, length: null }).map((row) => row.label)).toEqual([
      "Create revision",
      "Mod revision",
      "Version",
      "Lease",
    ]);
  });

  it("givenClosedPanel_whenToggledTwice_thenOpensThenCloses", () => {
    const { toggle } = useKeyDetails.getState();
    toggle("key-0");
    expect(useKeyDetails.getState().open).toEqual({ "key-0": true });
    toggle("key-0");
    expect(useKeyDetails.getState().open).toEqual({});
  });
});
