import { describe } from "vitest";
import { databaseEnabled, MARIADB_CONFIG, MARIADB_ROOT_CONFIG } from "../support/databases.js";
import { TYPE_PROBE_COPY_LIKE, TYPE_PROBE_EXPECTED } from "../support/typeProbe.js";
import { mysqlRoutines, runMysqlFamilyContract } from "./mysqlFamily.js";

describe.runIf(databaseEnabled("mariadb"))("mariadb server", () => {
  runMysqlFamilyContract(MARIADB_CONFIG, MARIADB_ROOT_CONFIG, {
    routines: mysqlRoutines("int(11)"),
    typeProbe: { expected: TYPE_PROBE_EXPECTED, copyTable: TYPE_PROBE_COPY_LIKE },
  });
});
