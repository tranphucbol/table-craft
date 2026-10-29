import { describe, expect, it } from "vitest";
import {
  compactJson,
  JSON_DETECT_MAX_CHARS,
  looksLikeJson,
  storedJson,
} from "@table-craft/desktop/renderer/model/jsonText.js";

const REASON = '{"domain":"UNSPECIFIED","reason":"UNSPECIFIED","metadata":{"pe_code":0,"tags":["a","b"]}}';

describe("JSON text", () => {
  it("givenObjectText_whenDetected_thenJson", () => {
    expect(looksLikeJson(REASON)).toBe(true);
    expect(looksLikeJson('  {"a": 1}\n')).toBe(true);
  });

  it("givenArrayText_whenDetected_thenJson", () => {
    expect(looksLikeJson('[1, "two", {"three": null}]')).toBe(true);
    expect(looksLikeJson("[]")).toBe(true);
  });

  it("givenBareStringNumberOrNull_whenDetected_thenText", () => {
    for (const text of ['"quoted"', "42", "true", "null", "", "plain words"]) {
      expect(looksLikeJson(text), text).toBe(false);
    }
  });

  it("givenBrokenJson_whenDetected_thenText", () => {
    for (const text of ['{"a":1', '{"a":1]', "{a:1}", "[1,2,]", "{} trailing"]) {
      expect(looksLikeJson(text), text).toBe(false);
    }
  });

  it("givenTextOverCap_whenDetected_thenText", () => {
    const filler = "x".repeat(JSON_DETECT_MAX_CHARS);
    expect(looksLikeJson(`{"a":"${filler}"}`)).toBe(false);
  });

  it("givenPrettyText_whenCompacted_thenWhitespaceOutsideStringsGone", () => {
    expect(compactJson('{\n  "a b": "c  d",\n  "e": [ 1, 2 ]\n}')).toBe('{"a b":"c  d","e":[1,2]}');
    expect(compactJson('{"q": "say \\"hi \\" ", "t":\t1}')).toBe('{"q":"say \\"hi \\" ","t":1}');
  });

  it("givenBigintAndLongDecimal_whenCompacted_thenDigitsKept", () => {
    expect(compactJson('{ "id": 12345678901234567890, "amount": 0.10000000000000000001 }')).toBe(
      '{"id":12345678901234567890,"amount":0.10000000000000000001}',
    );
  });

  it("givenCompactInitial_whenEditedPretty_thenStoredCompact", () => {
    const edited = '{\n  "domain": "PAYMENT",\n  "metadata": {\n    "pe_code": 7\n  }\n}';

    expect(storedJson(edited, '{"domain":"UNSPECIFIED","metadata":{"pe_code":0}}')).toEqual({
      text: '{"domain":"PAYMENT","metadata":{"pe_code":7}}',
      valid: true,
    });
  });

  it("givenPrettyInitial_whenEdited_thenStoredAsTyped", () => {
    const edited = '{\n  "a": 2\n}';

    expect(storedJson(edited, '{ "a": 1 }')).toEqual({ text: edited, valid: true });
  });

  it("givenInvalidEdit_whenStored_thenAsTypedAndFlagged", () => {
    const edited = '{\n  "a": \n}';

    expect(storedJson(edited, '{"a":1}')).toEqual({ text: edited, valid: false });
  });
});
