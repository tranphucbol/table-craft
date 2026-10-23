import { isLineComment, type Tok } from "./layoutNodes.js";

const LINE_BREAK = "\n";
const SPACE = " ";

/**
 * Text built line by line with the column it has reached. A line comment forces the next token
 * onto a new line at `indent`, the column the current layout continues at.
 */
export class Writer {
  out = "";
  column: number;
  indent: number;
  #content = false;
  #pendingBreak = false;

  constructor(column: number) {
    this.column = column;
    this.indent = column;
  }

  /** The text ends in a line comment, so nothing may follow it on its line. */
  get endsInLineComment(): boolean {
    return this.#pendingBreak;
  }

  newline(column: number = this.indent): void {
    this.#pendingBreak = false;
    const lineStart = this.out.lastIndexOf(LINE_BREAK) + 1;
    if (!this.#content) {
      if (lineStart === 0) return;
      this.out = this.out.slice(0, lineStart) + SPACE.repeat(column);
    } else {
      this.out += LINE_BREAK + SPACE.repeat(column);
    }
    this.column = column;
    this.#content = false;
  }

  pad(width: number): void {
    if (width <= 0) return;
    this.out += SPACE.repeat(width);
    this.column += width;
  }

  /** `text` (one token, or a comment that may span lines), a space before it when asked and the line has text. */
  write(text: string, spaceBefore: boolean): void {
    if (this.#pendingBreak) this.newline();
    else if (spaceBefore && this.#content) this.#append(SPACE);
    this.#append(text);
  }

  tok(tok: Tok, text: string, spaceBefore: boolean): void {
    for (const comment of tok.leading) {
      if (this.#content) this.newline();
      this.#append(comment);
      this.newline();
    }
    this.write(text, spaceBefore);
    for (const comment of tok.trailing) {
      this.#append(SPACE + comment);
      if (isLineComment(comment)) this.#pendingBreak = true;
    }
  }

  /** A comment on a line of its own. */
  comment(comment: string, column: number): void {
    this.newline(column);
    this.#append(comment);
    if (isLineComment(comment)) this.#pendingBreak = true;
  }

  #append(text: string): void {
    this.out += text;
    const lineBreak = text.lastIndexOf(LINE_BREAK);
    this.column = lineBreak < 0 ? this.column + text.length : text.length - lineBreak - 1;
    this.#content = true;
  }
}
