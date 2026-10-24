/**
 * Starts the `compose.yml` databases, leaving the TiDB container out when a remote TiDB answers
 * (`tidbTarget.ts`), and recreating any whose seed changed (`stack.ts`). The suites make the same
 * TiDB choice again in their global setup (`test/support/tidbScratch.ts`).
 */
import { upDatabases } from "./stack.js";
import { resolveTidbTarget } from "./tidbTarget.js";

const target = await resolveTidbTarget();
console.log(target.description);
await upDatabases(target);
