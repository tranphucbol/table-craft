import type { ServerRange } from "@table-craft/plugin-api/sql";

/** The flavours `serverIdentity` names: a boxed SQL Server by its major version, and Azure SQL. */
export const MSSQL_FLAVOUR = "mssql";
export const AZURE_FLAVOUR = "azure";

/** SQL Server's major versions: 15 is 2019, 16 is 2022 and 17 is 2025. */
const MAJOR_2019 = 15;
const MAJOR_2022 = 16;
const MAJOR_2025 = 17;

/** In SQL Server from that major version on; Azure SQL, always current, has it. */
function since(major: number): ServerRange {
  return { [MSSQL_FLAVOUR]: `>=${String(major)}` };
}

export const SQL_SERVER_2019: ServerRange = since(MAJOR_2019);
export const SQL_SERVER_2022: ServerRange = since(MAJOR_2022);
export const SQL_SERVER_2025: ServerRange = since(MAJOR_2025);

/** Before 2022, for the shorter signatures 2022 extended; Azure has the extended ones. */
export const BEFORE_2022: ServerRange = { [MSSQL_FLAVOUR]: `<${String(MAJOR_2022)}`, [AZURE_FLAVOUR]: false };

/** Every SQL Server, no Azure SQL Database: the reference's "Applies to" leaves it out. */
export const NOT_IN_AZURE: ServerRange = { [AZURE_FLAVOUR]: false };

/** Azure SQL only. */
export const AZURE_ONLY: ServerRange = { [MSSQL_FLAVOUR]: false };
