import type { ServerRange } from "@table-craft/plugin-api/sql";

/** The flavour every Oracle function range names, and the server identity carries. */
export const ORACLE_FLAVOUR = "oracle";

/** First in the 21c reference. */
export const FROM_21: ServerRange = { [ORACLE_FLAVOUR]: ">=21" };

/** First in the 23ai reference. */
export const FROM_23: ServerRange = { [ORACLE_FLAVOUR]: ">=23" };

/** In the 19c and 21c references, gone from the 23ai one. */
export const BEFORE_23: ServerRange = { [ORACLE_FLAVOUR]: "<23" };
