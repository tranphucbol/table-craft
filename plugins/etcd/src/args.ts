import { PluginError } from "@table-craft/plugin-api";
import type { CommandDoc } from "./docs.js";
import type { Token } from "./tokens.js";

const FLAG_PREFIX = "--";
const HEX_PREFIX = "0x";
const HEX_ID = /^(?:0x)?[0-9a-f]+$/i;
const DECIMAL = /^\d+$/;
const HEX_RADIX = 16;

/** A command's arguments: its positional tokens and the flags it was given, a switch as `true`. */
export interface Arguments {
  readonly positional: readonly Token[];
  readonly flags: ReadonlyMap<string, string | true>;
}

/** Whether a token is a flag: bare `--name`, never a quoted `"--name"`, which is a key or value. */
export function isFlag(token: Token): boolean {
  return !token.quoted && token.text.startsWith(FLAG_PREFIX);
}

function failure(doc: CommandDoc, message: string): PluginError {
  return new PluginError("statementFailed", `${doc.name}: ${message}`);
}

/** The arguments after a command's name, checked against its flags and its positional count. */
export function argumentsOf(doc: CommandDoc, tokens: readonly Token[]): Arguments {
  const positional: Token[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!isFlag(token)) {
      positional.push(token);
      continue;
    }
    const body = token.text.slice(FLAG_PREFIX.length);
    const equals = body.indexOf("=");
    const name = equals < 0 ? body : body.slice(0, equals);
    const flag = doc.flags.find((candidate) => candidate.name === name);
    if (flag === undefined) {
      const known = doc.flags.map((candidate) => `--${candidate.name}`).join(", ");
      throw failure(doc, `unknown flag --${name}. ${known === "" ? "It takes no flags." : `It takes ${known}.`}`);
    }
    if (flag.value === undefined) {
      if (equals >= 0) throw failure(doc, `--${name} takes no value.`);
      flags.set(name, true);
      continue;
    }
    if (equals >= 0) {
      flags.set(name, body.slice(equals + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined) throw failure(doc, `--${name} needs a value: --${name}=<${flag.value}>.`);
    flags.set(name, next.text);
    index += 1;
  }
  const required = doc.parameters.filter((parameter) => parameter.optional !== true).length;
  if (positional.length < required || positional.length > doc.parameters.length) {
    const names = doc.parameters.map((parameter) => `<${parameter.name}>`).join(" ");
    throw failure(doc, `expects ${names === "" ? "no arguments" : names}.`);
  }
  return { positional, flags };
}

/** A flag's whole-number value; `fallback` when absent. */
export function numberFlag(doc: CommandDoc, args: Arguments, name: string, fallback: number): number {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  if (value === true || !DECIMAL.test(value))
    throw failure(doc, `--${name} takes a whole number, not ${String(value)}.`);
  return Number(value);
}

/** A whole number argument as etcd's int64, a decimal string. */
export function decimalOf(doc: CommandDoc, what: string, text: string): string {
  if (!DECIMAL.test(text)) throw failure(doc, `${what} is a whole number, not ${text}.`);
  return BigInt(text).toString();
}

/** A lease id as `etcdctl` prints it, hex, as etcd's int64, a decimal string. */
export function leaseIdOf(doc: CommandDoc, text: string): string {
  if (!HEX_ID.test(text)) throw failure(doc, `the lease id is hex, as lease list prints it, not ${text}.`);
  return BigInt(text.toLowerCase().startsWith(HEX_PREFIX) ? text : `${HEX_PREFIX}${text}`).toString();
}

/** An int64 id, as etcd sends it, in the hex `etcdctl` prints. */
export function hexId(decimal: string): string {
  return BigInt(decimal).toString(HEX_RADIX);
}
