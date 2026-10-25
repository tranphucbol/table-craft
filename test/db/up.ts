/**
 * Starts the `compose.yml` databases `TABLE_CRAFT_DATABASES` selects (decision 099; MySQL and
 * TiDB unset), leaving the TiDB container out when a remote TiDB answers (`tidbTarget.ts`), and
 * recreating any whose seed changed (`stack.ts`). The suites make the same TiDB choice again in
 * their global setup (`test/support/tidbScratch.ts`).
 */
import { selectedDatabases } from "../support/databases.js";
import { describeSelection, upDatabases } from "./stack.js";
import { resolveTidbTarget } from "./tidbTarget.js";

const databases = selectedDatabases();
console.log(describeSelection(databases));
const target = await resolveTidbTarget();
if (databases.includes("tidb")) console.log(target.description);
await upDatabases(target, process.env, databases);
