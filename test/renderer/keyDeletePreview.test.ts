import { describe, expect, it } from "vitest";
import type { KeyDeletePreview } from "@table-craft/desktop/engine/protocol.js";
import { keyDeleteConfirmation } from "@table-craft/desktop/renderer/model/keyDeletePreview.js";

const text = (value: string) => ({ text: value, hex: null });
const preview = (keys: string | null, leasedKeys: string | null = "0"): KeyDeletePreview => ({
  token: "prepared-token",
  revision: "9007199254740993",
  counts: { revision: "9007199254740993", keys, leasedKeys },
  sampleKeys: Array.from({ length: 25 }, (_, index) => text(`app/${String(index)}`)),
  guard: "noNewOrModifiedKeys",
});
const folder = (prefix: string) => ({ kind: "prefix", prefix: text(prefix) }) as const;

describe("guarded key deletion confirmation", () => {
  it("givenExactPreview_whenConfirmed_thenPinnedRevisionExactCountsAndFirstTwenty", () => {
    const confirmation = keyDeleteConfirmation(preview("10000", "3"), folder("app/"));
    expect(confirmation.message).toContain("Exact key count: 10000");
    expect(confirmation.message).toContain("Leased key count: 3");
    expect(confirmation.message).toContain("revision 9007199254740993");
    expect(confirmation.message).toContain("rejects new or modified keys");
    expect(confirmation.items).toHaveLength(20);
    expect(confirmation.items?.at(-1)?.label).toBe("app/19");
    expect(confirmation).not.toHaveProperty("typed");
  });

  it.each(["10001", "900719925474099300000", null])(
    "givenLargeOrUnknownCount_%s_whenConfirmed_thenRequiresExactPrefix",
    (count) => {
      expect(keyDeleteConfirmation(preview(count), folder("app/[literal]/*/"))).toHaveProperty(
        "typed",
        "app/[literal]/*/",
      );
    },
  );

  it("givenUnknownCounts_whenConfirmed_thenNeverClaimsZeroAndRequiresTyping", () => {
    const confirmation = keyDeleteConfirmation(preview(null, null), folder("app/"));
    expect(confirmation.message).toContain("Key count unknown");
    expect(confirmation.message).toContain("Leased key count unknown");
    expect(confirmation.typed).toBe("app/");
    expect(keyDeleteConfirmation(preview("1", null), folder("app/"))).toHaveProperty("typed", "app/");
  });

  it.each([
    ["", "DELETE"],
    ["/", "/"],
  ])("givenRootPrefix_%s_whenConfirmed_thenRequiresNonemptyTyping", (prefix, typed) => {
    expect(keyDeleteConfirmation(preview("1"), folder(prefix))).toHaveProperty("typed", typed);
  });

  it("givenSingleBinaryKey_whenConfirmed_thenShowsExactBytesWithoutFolderTyping", () => {
    const key = { text: "\\xff", hex: "ff" };
    const confirmation = keyDeleteConfirmation({ ...preview("1"), sampleKeys: [key] }, { kind: "key", key });
    expect(confirmation.title).toBe("Delete Key");
    expect(confirmation.items).toEqual([{ label: "\\xff", detail: "Hex: ff", tone: "info" }]);
    expect(confirmation).not.toHaveProperty("typed");
  });
});
