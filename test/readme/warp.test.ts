import { describe, expect, it } from "vitest";
import { setTomlKey } from "./warp.js";

const SETTINGS = [
  "[appearance.window]",
  "zoom_level = 110",
  "",
  "[appearance.vertical_tabs]",
  "enabled = true",
  "",
].join("\n");

describe("README Warp settings", () => {
  it("givenKeyInTable_whenSet_thenOnlyItsValueChanges", () => {
    expect(setTomlKey(SETTINGS, "appearance.vertical_tabs", "enabled", "false")).toBe(
      SETTINGS.replace("enabled = true", "enabled = false"),
    );
  });

  it("givenKeyMissing_whenSet_thenAddedUnderItsTable", () => {
    expect(setTomlKey(SETTINGS, "appearance.window", "new_windows_num_rows", "40")).toBe(
      SETTINGS.replace("[appearance.window]", "[appearance.window]\nnew_windows_num_rows = 40"),
    );
  });

  it("givenTableMissing_whenSet_thenTableAppended", () => {
    expect(setTomlKey(SETTINGS, "agents.third_party", "should_render_cli_agent_toolbar", "false")).toBe(
      `${SETTINGS.trimEnd()}\n\n[agents.third_party]\nshould_render_cli_agent_toolbar = false\n`,
    );
  });
});
