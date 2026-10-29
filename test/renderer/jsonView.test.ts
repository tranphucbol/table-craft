import { beforeEach, describe, expect, it } from "vitest";
import { jsonColumnKey, jsonOwnerKey, jsonViewOf } from "@table-craft/desktop/renderer/model/jsonView.js";
import { useJsonView } from "@table-craft/desktop/renderer/state/jsonView.js";

const JSON_TEXT = '{"domain":"UNSPECIFIED"}';
const OWNER = jsonOwnerKey("console-1", "handle-1");

function judged(column: string, text: string | null, json = false, detect = true) {
  const override = useJsonView.getState().overrides[jsonColumnKey(OWNER, column)];
  return jsonViewOf({ text, json, detect, override });
}

describe("JSON view", () => {
  beforeEach(() => useJsonView.setState({ overrides: {}, panels: {} }));

  it("givenDetectOn_whenJsonText_thenOn", () => {
    expect(judged("reason", JSON_TEXT)).toEqual({ available: true, on: true });
  });

  it("givenDetectOff_whenJsonText_thenAvailableButOff", () => {
    expect(judged("reason", JSON_TEXT, false, false)).toEqual({ available: true, on: false });
  });

  it("givenDetectOff_whenJsonColumn_thenOn", () => {
    expect(judged("payload", '"a json string"', true, false)).toEqual({ available: true, on: true });
  });

  it("givenOverrideOff_whenAnotherRow_thenStaysOff", () => {
    useJsonView.getState().set(jsonColumnKey(OWNER, "reason"), false);

    expect(judged("reason", JSON_TEXT)).toEqual({ available: true, on: false });
    expect(judged("reason", "[1,2,3]")).toEqual({ available: true, on: false });
  });

  it("givenOverride_whenOtherColumn_thenDefault", () => {
    useJsonView.getState().set(jsonColumnKey(OWNER, "reason"), false);

    expect(judged("metadata", JSON_TEXT)).toEqual({ available: true, on: true });
  });

  it("givenNullOrBytesOrPlainText_whenJudged_thenUnavailable", () => {
    for (const text of [null, "plain words", "42", '"quoted"']) {
      expect(judged("reason", text), String(text)).toEqual({ available: false, on: false });
    }
  });

  it("givenRerunHandle_whenJudged_thenDefault", () => {
    useJsonView.getState().set(jsonColumnKey(OWNER, "reason"), false);
    const rerun = jsonOwnerKey("console-1", "handle-2");
    const override = useJsonView.getState().overrides[jsonColumnKey(rerun, "reason")];

    expect(jsonViewOf({ text: JSON_TEXT, json: false, detect: true, override })).toEqual({ available: true, on: true });
  });

  it("givenPanelPublished_whenWithdrawn_thenGone", () => {
    const { publish } = useJsonView.getState();
    publish(OWNER, { key: jsonColumnKey(OWNER, "reason"), on: true });
    expect(useJsonView.getState().panels[OWNER]).toEqual({ key: jsonColumnKey(OWNER, "reason"), on: true });

    publish(OWNER, null);
    expect(useJsonView.getState().panels).toEqual({});
  });
});
