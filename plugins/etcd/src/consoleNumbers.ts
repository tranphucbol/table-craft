import { PluginError } from "@table-craft/plugin-api";

const DECIMAL = /^(?:0|[1-9]\d*)$/;
const SIGNED_DECIMAL = /^(?:0|-?[1-9]\d*)$/;
const HEX = /^(?:0x)?[0-9a-f]{1,16}$/i;
const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);

export function consoleInt64(text: string, signed = false): string {
  if (text.length > 20 || !(signed ? SIGNED_DECIMAL : DECIMAL).test(text)) {
    throw new PluginError("statementFailed", "Expected a canonical decimal int64 string.");
  }
  const value = BigInt(text);
  if (value > INT64_MAX || value < (signed ? INT64_MIN : 0n)) {
    throw new PluginError("statementFailed", "Integer is outside the int64 range.");
  }
  return text;
}

export function consoleLeaseId(text: string): string {
  if (!HEX.test(text))
    throw new PluginError("statementFailed", "Expected a lease ID of at most sixteen hexadecimal digits.");
  return BigInt.asIntN(64, BigInt(text.toLowerCase().startsWith("0x") ? text : `0x${text}`)).toString();
}
