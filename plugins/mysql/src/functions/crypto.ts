import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { removedIn, since, TIDB_AFTER_4, tidbOnly } from "./ranges.js";

const MYSQL_8 = "8.0";
const TIDB_PASSWORD_POLICY = "6.5";

/**
 * Encryption and compression functions, summarised in our own words from
 * https://dev.mysql.com/doc/refman/8.4/en/encryption-functions.html,
 * https://dev.mysql.com/doc/refman/5.7/en/encryption-functions.html,
 * https://docs.pingcap.com/tidb/v4.0/encryption-and-compression-functions and
 * https://docs.pingcap.com/tidb/stable/encryption-and-compression-functions.
 */
export const CRYPTO_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("encryption", [
  ["AES_DECRYPT", "crypt, key, iv? -> string", "Decrypts what AES_ENCRYPT encrypted with the same key."],
  ["AES_ENCRYPT", "str, key, iv? -> string", "Encrypts a string with AES, as binary."],
  ["COMPRESS", "str -> string", "Compresses a string, as binary."],
  ["DECODE", "crypt, password -> string", "Decrypts what ENCODE encrypted.", removedIn(MYSQL_8)],
  ["DES_DECRYPT", "crypt, key? -> string", "Decrypts what DES_ENCRYPT encrypted.", removedIn(MYSQL_8, false)],
  ["DES_ENCRYPT", "str, key? -> string", "Encrypts a string with Triple-DES.", removedIn(MYSQL_8, false)],
  ["ENCODE", "str, password -> string", "Encrypts a string with a password, weakly.", removedIn(MYSQL_8)],
  ["ENCRYPT", "str, salt? -> string", "Hashes a string with the system crypt() call.", removedIn(MYSQL_8, false)],
  ["MD5", "str -> string", "The 128-bit MD5 checksum, as 32 hex digits."],
  ["PASSWORD", "str -> string", "The hash the server stored passwords as.", removedIn(MYSQL_8)],
  ["RANDOM_BYTES", "length -> string", "That many random bytes, from a cryptographic source."],
  ["SHA", "str -> string", "Another name for SHA1."],
  ["SHA1", "str -> string", "The 160-bit SHA-1 checksum, as 40 hex digits."],
  ["SHA2", "str, bits -> string", "A SHA-2 checksum of 224, 256, 384 or 512 bits, as hex digits."],
  ["SM3", "str -> string", "The SM3 checksum, as hex digits.", tidbOnly(TIDB_AFTER_4)],
  [
    "STATEMENT_DIGEST",
    "statement -> string",
    "The hash the server groups statements of the same shape under.",
    since("8.0.4", false),
  ],
  [
    "STATEMENT_DIGEST_TEXT",
    "statement -> string",
    "The statement with its literals turned into placeholders.",
    since("8.0.4", false),
  ],
  ["UNCOMPRESS", "str -> string", "Expands what COMPRESS compressed."],
  ["UNCOMPRESSED_LENGTH", "str -> integer", "How long a compressed string was before COMPRESS."],
  [
    "VALIDATE_PASSWORD_STRENGTH",
    "password -> integer",
    "How strong a password is, from 0 to 100.",
    since(null, TIDB_PASSWORD_POLICY),
  ],
]);
