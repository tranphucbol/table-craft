import { omittedMessages, SERVER_MESSAGE_LIMIT } from "@table-craft/plugin-api";
import { warningCount, warningMessages } from "@table-craft/plugin-mysql/warnings";
import { NoticeCollector, noticeMessage } from "@table-craft/plugin-postgres/notices";
import { describe, expect, it } from "vitest";

describe("mysql warnings", () => {
  it("givenShowWarningsRows_whenRead_thenLevelsCodesAndText", () => {
    const rows = [
      { Level: "Warning", Code: 1815, Message: "use_index(test.i) is inapplicable" },
      { Level: "Note", Code: 1003, Message: "rewritten" },
      { Level: "Error", Code: 1146, Message: "no table" },
    ];

    expect(warningMessages(rows, rows.length)).toEqual([
      { level: "warning", code: "1815", text: "use_index(test.i) is inapplicable" },
      { level: "notice", code: "1003", text: "rewritten" },
      { level: "error", code: "1146", text: "no table" },
    ]);
  });

  it("givenCountAboveRowsRead_whenRead_thenSaysHowManyMore", () => {
    const rows = [{ Level: "Warning", Code: 1292, Message: "truncated" }];

    expect(warningMessages(rows, 70).at(-1)).toEqual(omittedMessages(69));
  });

  it("givenMoreRowsThanTheLimit_whenRead_thenLimitKept", () => {
    const rows = Array.from({ length: SERVER_MESSAGE_LIMIT + 3 }, () => ({ Level: "Warning", Code: 1, Message: "w" }));

    const messages = warningMessages(rows, rows.length);

    expect(messages).toHaveLength(SERVER_MESSAGE_LIMIT + 1);
    expect(messages.at(-1)).toEqual(omittedMessages(3));
  });

  it("givenEofWarningField_whenCounted_thenUnsigned16Bit", () => {
    expect(warningCount(-1)).toBe(65_535);
    expect(warningCount(2)).toBe(2);
  });
});

describe("postgres notices", () => {
  it("givenSeverities_whenRead_thenLevels", () => {
    expect(noticeMessage({ severity: "WARNING", code: "01000", message: "w" })).toEqual({
      level: "warning",
      code: "01000",
      text: "w",
    });
    expect(noticeMessage({ severity: "NOTICE", code: "00000", message: "n" }).level).toBe("notice");
    expect(noticeMessage({ severity: "INFO", message: "i" })).toEqual({ level: "info", code: null, text: "i" });
  });

  it("givenMoreNoticesThanTheLimit_whenCollected_thenLimitAndHowManyMore", () => {
    const collector = new NoticeCollector();
    for (let index = 0; index < SERVER_MESSAGE_LIMIT + 2; index += 1)
      collector.add({ severity: "NOTICE", message: "n" });

    const messages = collector.messages();

    expect(messages).toHaveLength(SERVER_MESSAGE_LIMIT + 1);
    expect(messages.at(-1)).toEqual(omittedMessages(2));
  });
});
