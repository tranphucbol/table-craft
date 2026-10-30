import { StringStream } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { highlighterOf, keywordDialectOf } from "@table-craft/desktop/renderer/console/Editor.js";
import { etcdLanguage, etcdParser } from "@table-craft/desktop/renderer/console/highlighters/etcd.js";

const INDENT = 2;

/** Each line's styled tokens, `style:text`; the state carries over lines as in the editor. */
function tokens(...lines: string[]): string[][] {
  const state = etcdParser.startState?.(INDENT) ?? { commandSeen: false, subcommandNext: false, compare: false };
  return lines.map((line) => {
    const stream = new StringStream(line, INDENT, INDENT);
    const found: string[] = [];
    while (!stream.eol()) {
      const style = etcdParser.token(stream, state);
      if (style !== null) found.push(`${style}:${stream.current()}`);
      stream.start = stream.pos;
    }
    return found;
  });
}

describe("etcd highlighter", () => {
  it("givenHighlightEtcd_whenEditorBuilt_thenCommandHighlighterAndNoSqlKeywords", () => {
    expect(highlighterOf({ capabilities: ["commands"], highlight: "etcd" })).toBe(etcdLanguage);
    expect(keywordDialectOf({ capabilities: ["commands"], highlight: "etcd" })).toBeNull();
  });

  it("givenGetWithFlags_whenTokenized_thenCommandFlagsAndValues", () => {
    expect(tokens("get /config/ --prefix --limit=10 --keys-only")).toEqual([
      [
        "keyword:get",
        "name.special:--prefix",
        "name.special:--limit",
        "operator:=",
        "number:10",
        "name.special:--keys-only",
      ],
    ]);
  });

  it("givenPutWithQuotedValue_whenTokenized_thenStringAndNumber", () => {
    expect(tokens('put /app/name "Ann \\"A\\"" --lease=694d8a1c', "put /n 42")).toEqual([
      ["keyword:put", 'string:"Ann \\"A\\""', "name.special:--lease", "operator:="],
      ["keyword:put", "number:42"],
    ]);
  });

  it("givenCommandGroup_whenTokenized_thenSubcommandIsAKeywordToo", () => {
    expect(tokens("lease grant 60", "member list -w table", "defrag")).toEqual([
      ["keyword:lease", "keyword:grant", "number:60"],
      ["keyword:member", "keyword:list", "name.special:-w"],
      ["keyword:defrag"],
    ]);
  });

  it("givenTxnBlock_whenTokenized_thenLabelsComparesAndOps", () => {
    expect(
      tokens("txn", 'if: mod("/a") > 5', 'value(/b) != "x"', "then:", "  put /a 1", "else: del /a", "end"),
    ).toEqual([
      ["keyword:txn"],
      ["keyword:if:", "typeName:mod", "punctuation:(", 'string:"/a"', "punctuation:)", "operator:>", "number:5"],
      ["typeName:value", "punctuation:(", "punctuation:)", "operator:!=", 'string:"x"'],
      ["keyword:then:"],
      ["keyword:put", "number:1"],
      ["keyword:else:", "keyword:del"],
      ["keyword:end"],
    ]);
  });

  it("givenLeaseCompareAndLeaseCommand_whenTokenized_thenParenDecides", () => {
    expect(tokens('lease("/a") = 0', "lease list")).toEqual([
      ["typeName:lease", "punctuation:(", 'string:"/a"', "punctuation:)", "operator:=", "number:0"],
      ["keyword:lease", "keyword:list"],
    ]);
  });

  it("givenCommentAndUnknownCommand_whenTokenized_thenCommentStyledAndUnknownPlain", () => {
    expect(tokens("# seed the config", "frobnicate /a 1", "get /a#b")).toEqual([
      ["lineComment:# seed the config"],
      ["number:1"],
      ["keyword:get"],
    ]);
  });
});
