import {
  PluginError,
  type BoundStatement,
  type ParameterStyle,
  type ParameterValue,
  type SqlLanguage,
  type SqlParameter,
} from "@table-craft/plugin-api";
import { Lexer, type SqlDialectOptions, type Token } from "./tokens.js";

/**
 * How a driver spells the placeholders it binds: `$1` once per value (node-postgres), `?` once per
 * occurrence (mysql2, SQLite), `:1` once per occurrence (node-oracledb, which binds an array by
 * position of occurrence), or `@p1` once per value (tedious, which binds by name).
 */
export type NativePlaceholder = "numbered" | "positional" | "colonNumbered" | "atNumbered";

interface NativeForm {
  /** One value per distinct name, reused wherever the name repeats; else one per occurrence. */
  readonly perName: boolean;
  /** The placeholder for the value at `number`, counting from 1. */
  readonly spell: (number: number) => string;
}

const NATIVE_FORMS: Readonly<Record<NativePlaceholder, NativeForm>> = {
  numbered: { perName: true, spell: (number) => `$${String(number)}` },
  positional: { perName: false, spell: () => "?" },
  colonNumbered: { perName: false, spell: (number) => `:${String(number)}` },
  atNumbered: { perName: true, spell: (number) => `@p${String(number)}` },
};

/** What `sqlParameters` needs to know about a dialect (decision 043). */
export interface ParameterOptions {
  readonly dialect: SqlDialectOptions;
  /** The placeholder forms a statement may hold; anything else is left as SQL. */
  readonly styles: readonly ParameterStyle[];
  readonly native: NativePlaceholder;
}

const NAMED_PREFIX = ":";
const POSITIONAL_MARK = "?";
const NUMBERED = /^\$[1-9]\d*$/;
const NAME_START = /^[A-Za-z_\u0080-\uffff]/;
/** A `:` after one of these is a slice bound, a label or the second half of `::`, not a parameter. */
const NOT_BEFORE_NAMED = /[A-Za-z0-9_$:\u0080-\uffff\]]/;

function namedAt(text: string, colon: Token, next: Token | null): Token | null {
  if (next?.kind !== "word" || next.from !== colon.to) return null;
  if (!NAME_START.test(text.charAt(next.from))) return null;
  const before = colon.from > 0 ? text.charAt(colon.from - 1) : "";
  return NOT_BEFORE_NAMED.test(before) ? null : next;
}

function missingValue(name: string): PluginError {
  return new PluginError(
    "statementFailed",
    `No value for the parameter ${name}; run the statement again and give it one.`,
  );
}

/**
 * Detection and binding of `:name`, `$1` and `?` placeholders on the lexer the splitter uses
 * (decision 043), so nothing inside a string, quoted identifier, comment or dollar quote counts.
 */
export function sqlParameters(options: ParameterOptions): Pick<SqlLanguage, "parameters" | "bind"> {
  const styles = new Set(options.styles);

  const parameters = (statement: string): SqlParameter[] => {
    const lexer = new Lexer(statement, options.dialect);
    const found: SqlParameter[] = [];
    let positional = 0;
    let token = lexer.next();
    while (token !== null) {
      const next = lexer.next();
      const text = statement.slice(token.from, token.to);
      if (token.kind === "symbol" && text === NAMED_PREFIX && styles.has("named")) {
        const name = namedAt(statement, token, next);
        if (name !== null) {
          found.push({ name: statement.slice(token.from, name.to), from: token.from, to: name.to, style: "named" });
          token = lexer.next();
          continue;
        }
      } else if (token.kind === "symbol" && text === POSITIONAL_MARK && styles.has("positional")) {
        positional += 1;
        found.push({
          name: `${POSITIONAL_MARK}${String(positional)}`,
          from: token.from,
          to: token.to,
          style: "positional",
        });
      } else if (token.kind === "word" && styles.has("numbered") && NUMBERED.test(text)) {
        found.push({ name: text, from: token.from, to: token.to, style: "numbered" });
      }
      token = next;
    }
    return found;
  };

  const bind = (statement: string, values: Readonly<Record<string, ParameterValue>>): BoundStatement => {
    const found = parameters(statement);
    const form = NATIVE_FORMS[options.native];
    const params: ParameterValue[] = [];
    const numbers = new Map<string, number>();
    let sql = "";
    let at = 0;
    for (const parameter of found) {
      if (!Object.hasOwn(values, parameter.name)) throw missingValue(parameter.name);
      const value = values[parameter.name] ?? null;
      let number = form.perName ? numbers.get(parameter.name) : undefined;
      if (number === undefined) {
        params.push(value);
        number = params.length;
        numbers.set(parameter.name, number);
      }
      const placeholder = form.spell(number);
      sql += statement.slice(at, parameter.from) + placeholder;
      at = parameter.to;
    }
    return { sql: sql + statement.slice(at), params };
  };

  return { parameters, bind };
}
