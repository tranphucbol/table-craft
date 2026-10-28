import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { NOT_IN_AZURE } from "./ranges.js";

/**
 * Cryptographic functions, summarised in our own words from
 * https://learn.microsoft.com/en-us/sql/t-sql/functions/cryptographic-functions-transact-sql.
 */
export const ENCRYPTION_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("encryption", [
  ["ASYMKEY_ID", "name -> integer", "The id of an asymmetric key."],
  ["ASYMKEYPROPERTY", "key_id, property -> any", "A property of an asymmetric key, such as its algorithm."],
  ["CERTPROPERTY", "cert_id, property -> any", "A property of a certificate, such as its expiry date."],
  ["CERT_ID", "name -> integer", "The id of a certificate."],
  ["CRYPT_GEN_RANDOM", "length, seed? -> varbinary", "Cryptographically random bytes."],
  ["DECRYPTBYASYMKEY", "key_id, ciphertext, password? -> varbinary", "Decrypts with an asymmetric key."],
  ["DECRYPTBYCERT", "cert_id, ciphertext, password? -> varbinary", "Decrypts with a certificate's private key."],
  [
    "DECRYPTBYKEY",
    "ciphertext, add_authenticator?, authenticator? -> varbinary",
    "Decrypts with the symmetric key the ciphertext names, which must be open.",
  ],
  [
    "DECRYPTBYKEYAUTOASYMKEY",
    "key_id, password, ciphertext, add_authenticator?, authenticator? -> varbinary",
    "Decrypts with a symmetric key that an asymmetric key opens.",
    NOT_IN_AZURE,
  ],
  [
    "DECRYPTBYKEYAUTOCERT",
    "cert_id, password, ciphertext, add_authenticator?, authenticator? -> varbinary",
    "Decrypts with a symmetric key that a certificate opens.",
    NOT_IN_AZURE,
  ],
  [
    "DECRYPTBYPASSPHRASE",
    "passphrase, ciphertext, add_authenticator?, authenticator? -> varbinary",
    "Decrypts what ENCRYPTBYPASSPHRASE encrypted.",
  ],
  ["ENCRYPTBYASYMKEY", "key_id, plaintext -> varbinary", "Encrypts with an asymmetric key."],
  ["ENCRYPTBYCERT", "cert_id, plaintext -> varbinary", "Encrypts with a certificate's public key."],
  [
    "ENCRYPTBYKEY",
    "key_guid, plaintext, add_authenticator?, authenticator? -> varbinary",
    "Encrypts with an open symmetric key.",
  ],
  [
    "ENCRYPTBYPASSPHRASE",
    "passphrase, plaintext, add_authenticator?, authenticator? -> varbinary",
    "Encrypts with a key derived from a passphrase.",
  ],
  ["HASHBYTES", "algorithm, input -> varbinary", "A hash of the input, such as 'SHA2_256'."],
  [
    "IS_OBJECTSIGNED",
    "class, id, thumbprint_class, thumbprint -> integer",
    "Whether an object is signed by a certificate or key.",
  ],
  ["KEY_GUID", "name -> uniqueidentifier", "The GUID of a symmetric key."],
  ["KEY_ID", "name -> integer", "The id of a symmetric key."],
  ["KEY_NAME", "ciphertext_or_guid -> string", "The name of the symmetric key behind a ciphertext or GUID."],
  ["SIGNBYASYMKEY", "key_id, plaintext, password? -> varbinary", "Signs text with an asymmetric key."],
  ["SIGNBYCERT", "cert_id, plaintext, password? -> varbinary", "Signs text with a certificate."],
  ["SYMKEYPROPERTY", "key_id, property -> any", "A property of a symmetric key, such as its algorithm."],
  [
    "VERIFYSIGNEDBYCERT",
    "cert_id, signed_data, signature -> integer",
    "1 when a certificate's signature matches the data.",
  ],
  [
    "VERIFYSIGNEDBYASYMKEY",
    "key_id, signed_data, signature -> integer",
    "1 when an asymmetric key's signature matches the data.",
  ],
]);
