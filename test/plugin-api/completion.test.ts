import type { CompletionResult, Namespace, Relation } from "@table-craft/plugin-api";
import {
  functionSpecs,
  quoteIdentifierWith,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  sqlCompleter,
} from "@table-craft/plugin-api/sql";
import { describe, expect, it } from "vitest";
import { ARCHIVE, fakeCatalog, fixtureRelations, PUBLIC, relation } from "../support/completionCatalog.js";

const postgres = sqlCompleter({
  dialect: { dollarQuotes: true },
  identifierFolding: "lower",
  plainIdentifier: /^[a-z_][a-z0-9_$]*$/,
  quoteIdentifier: quoteIdentifierWith('"'),
  keywords: SQL_KEYWORDS,
  functions: SQL_FUNCTIONS,
});

const mysql = sqlCompleter({
  dialect: { backslashEscapes: true, hashComments: true },
  identifierFolding: "none",
  plainIdentifier: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  quoteIdentifier: quoteIdentifierWith("`"),
  keywords: SQL_KEYWORDS,
  functions: SQL_FUNCTIONS,
});

const CARET = "|";
const WIDE_TABLES = 500;
const WIDE_COLUMNS = 30;
const WIDE_BUDGET_MS = 100;

/** `text` with `|` marking the caret. */
function at(marked: string): { text: string; offset: number } {
  const offset = marked.indexOf(CARET);
  return { text: marked.replace(CARET, ""), offset };
}

function complete(marked: string, completer = postgres, catalog = fakeCatalog()): Promise<CompletionResult> {
  return completer.complete(at(marked), catalog);
}

function labels(result: CompletionResult, kind?: string): string[] {
  return result.items.filter((item) => kind === undefined || item.kind === kind).map((item) => item.label);
}

/** The items in the order an empty prefix shows them: by boost, then label. */
function ranked(result: CompletionResult): string[] {
  return [...result.items]
    .sort((left, right) => right.boost - left.boost || left.label.localeCompare(right.label))
    .map((item) => item.label);
}

describe("sqlCompleter.complete", () => {
  it("givenFromClause_whenCompleting_thenOffersRelationsOfCurrentNamespace", async () => {
    const result = await complete("SELECT * FROM |");

    expect(labels(result, "table")).toEqual(["Line Items", "customers", "orders"]);
    expect(labels(result, "view")).toEqual(["order_totals"]);
    expect(labels(result, "namespace")).toEqual(["archive"]);
    expect(result.items.find((item) => item.label === "orders")?.detail).toBe("public");
    expect(labels(result, "keyword")).toEqual([]);
  });

  it("givenTypedPrefix_whenCompleting_thenSpanCoversTheWordBeforeTheCaret", async () => {
    const result = await complete("SELECT * FROM ord|");

    expect(result).toMatchObject({ from: 14, to: 17, validFor: "^[A-Za-z0-9_$]*$" });
  });

  it("givenAliasDot_whenCompleting_thenOffersColumnsOfAliasedRelation", async () => {
    const result = await complete("SELECT o.| FROM orders o");

    expect(labels(result)).toEqual(["id", "customer_id", "total"]);
    expect(result.items.map((item) => item.detail)).toEqual(["integer", "integer", "numeric(12,2)"]);
    expect(result).toMatchObject({ from: 9, to: 9 });
  });

  it("givenRelationNameDot_whenCompleting_thenOffersItsColumns", async () => {
    const result = await complete("SELECT orders.| FROM orders");

    expect(labels(result)).toEqual(["id", "customer_id", "total"]);
  });

  it("givenCteDot_whenCompleting_thenOffersCteSelectListColumns", async () => {
    const result = await complete("WITH t AS (SELECT id, name AS label FROM customers) SELECT t.| FROM t");

    expect(labels(result)).toEqual(["id", "label"]);
  });

  it("givenCteWithColumnList_whenCompleting_thenOffersListedColumns", async () => {
    const result = await complete("WITH t (a, b) AS (SELECT id, name FROM customers) SELECT t.|");

    expect(labels(result)).toEqual(["a", "b"]);
  });

  it("givenCteStar_whenCompleting_thenExpandsItsSource", async () => {
    const result = await complete("WITH t AS (SELECT * FROM customers) SELECT | FROM t");

    expect(labels(result, "column")).toEqual(["id", "name", "email"]);
  });

  it("givenDerivedTableAlias_whenCompleting_thenOffersItsColumns", async () => {
    const result = await complete("SELECT d.| FROM (SELECT o.id, o.total AS amount FROM orders o) d");

    expect(labels(result)).toEqual(["id", "amount"]);
  });

  it("givenNamespaceDot_whenCompleting_thenOffersItsRelations", async () => {
    const catalog = fakeCatalog();
    const result = await complete("SELECT * FROM archive.|", postgres, catalog);

    expect(labels(result)).toEqual(["old_orders"]);
    expect(catalog.asked).toContainEqual([...ARCHIVE]);
  });

  it("givenFromClause_whenCompleting_thenOffersCtes", async () => {
    const result = await complete("WITH recent AS (SELECT 1) SELECT * FROM |");

    expect(labels(result, "cte")).toEqual(["recent"]);
  });

  it("givenJoinAfterTableWithForeignKey_whenCompleting_thenJoinItemFirstWithOnClause", async () => {
    const result = await complete("SELECT * FROM orders o JOIN |");

    expect(ranked(result)[0]).toBe("customers c ON c.id = o.customer_id");
    const join = result.items.find((item) => item.kind === "join");
    expect(join).toMatchObject({ apply: "customers c ON c.id = o.customer_id", detail: "orders_customer_id_fkey" });
  });

  it("givenIncomingForeignKey_whenCompletingJoin_thenOffersReferencingTable", async () => {
    const result = await complete("SELECT * FROM customers c JOIN |");

    expect(labels(result, "join")).toEqual([
      "orders o ON o.customer_id = c.id",
      "archive.old_orders oo ON oo.customer_id = c.id",
    ]);
  });

  it("givenJoinAliasTaken_whenCompletingJoin_thenAliasGetsADigit", async () => {
    const result = await complete("SELECT * FROM orders c JOIN |");

    expect(labels(result, "join")).toEqual(["customers c1 ON c1.id = c.customer_id"]);
  });

  it("givenUnaliasedRelation_whenCompletingJoin_thenOnUsesItsName", async () => {
    const result = await complete("SELECT * FROM orders JOIN |");

    expect(labels(result, "join")).toEqual(["customers c ON c.id = orders.customer_id"]);
  });

  it("givenTwoRelationsShareColumnName_whenCompletingSelectList_thenItemsQualifiedByAlias", async () => {
    const result = await complete("SELECT | FROM orders o JOIN customers c ON c.id = o.customer_id");

    const columns = labels(result, "column");
    expect(columns).toEqual(expect.arrayContaining(["o.id", "c.id", "customer_id", "total", "name", "email"]));
    expect(columns).not.toContain("id");
    expect(result.items.find((item) => item.label === "o.id")?.apply).toBe("o.id");
    expect(labels(result, "alias")).toEqual(["o", "c"]);
    expect(labels(result, "function")).toContain("count");
    expect(labels(result, "keyword")).toContain("WHERE");
  });

  it("givenWhereClause_whenCompleting_thenColumnsRankAboveKeywords", async () => {
    const result = await complete("SELECT * FROM orders WHERE |");

    expect(ranked(result).slice(0, 3)).toEqual(["customer_id", "id", "total"]);
  });

  it("givenNameNeedingQuotes_whenCompleting_thenApplyIsQuoted", async () => {
    const result = await complete("SELECT * FROM Li|");

    expect(result.items.find((item) => item.label === "Line Items")?.apply).toBe('"Line Items"');
    expect(result.items.find((item) => item.label === "orders")?.apply).toBe("orders");
  });

  it("givenNameNeedingQuotesInMysql_whenCompleting_thenApplyUsesBackticks", async () => {
    const result = await complete("SELECT * FROM Li|", mysql);

    expect(result.items.find((item) => item.label === "Line Items")?.apply).toBe("`Line Items`");
  });

  it("givenKeywordColumnName_whenCompleting_thenApplyIsQuoted", async () => {
    const catalog = fakeCatalog(new Map([[JSON.stringify(PUBLIC), [relation("events", [["order", "text"]])]]]));
    const result = await complete("SELECT | FROM events", postgres, catalog);

    expect(result.items.find((item) => item.label === "order")?.apply).toBe('"order"');
  });

  it("givenOpenQuote_whenCompleting_thenLabelsAreQuotedAndNotReused", async () => {
    const result = await complete('SELECT * FROM "Li|');

    expect(labels(result, "table")).toContain('"Line Items"');
    expect(result.validFor).toBeNull();
  });

  it("givenInsertColumnList_whenCompleting_thenOffersTargetColumns", async () => {
    const result = await complete("INSERT INTO orders (|) VALUES (1)");

    expect(labels(result)).toEqual(["id", "customer_id", "total"]);
  });

  it("givenUpdateSet_whenCompleting_thenOffersTargetColumns", async () => {
    const result = await complete("UPDATE customers SET | WHERE id = 1");

    expect(labels(result, "column")).toEqual(["id", "name", "email"]);
  });

  it("givenDeleteWhere_whenCompleting_thenOffersTargetColumns", async () => {
    const result = await complete("DELETE FROM customers WHERE |");

    expect(labels(result, "column")).toEqual(["id", "name", "email"]);
  });

  it("givenCommaJoin_whenCompletingSecondRelation_thenOffersRelations", async () => {
    const result = await complete("SELECT * FROM orders o, |");

    expect(labels(result, "table")).toContain("customers");
  });

  it("givenCommaJoin_whenCompletingColumns_thenBothRelationsAreInScope", async () => {
    const result = await complete("SELECT c.| FROM orders o, customers c");

    expect(labels(result)).toEqual(["id", "name", "email"]);
  });

  it("givenSubqueryInWhere_whenCompletingOuterAlias_thenOffersOuterColumns", async () => {
    const result = await complete("SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.|)");

    expect(labels(result)).toEqual(["id", "customer_id", "total"]);
  });

  it("givenStatementBeforeSemicolon_whenCompletingNextOne_thenIgnoresIt", async () => {
    const result = await complete("SELECT * FROM orders o; SELECT o.|");

    expect(labels(result)).toEqual([]);
  });

  it("givenCaretInString_whenCompleting_thenOffersNothing", async () => {
    const result = await complete("SELECT * FROM orders WHERE total = 'o|'");

    expect(result.items).toEqual([]);
  });

  it("givenCaretAfterRelation_whenCompleting_thenOffersKeywords", async () => {
    const result = await complete("SELECT * FROM orders |");

    expect(labels(result, "keyword")).toContain("WHERE");
    expect(labels(result, "table")).toEqual([]);
  });

  it("givenEmptyText_whenCompleting_thenOffersKeywords", async () => {
    const result = await complete("|");

    expect(labels(result)).toContain("SELECT");
  });

  it("givenUnresolvableRelation_whenCompleting_thenIgnoresIt", async () => {
    const result = await complete("SELECT x.| FROM nowhere x");

    expect(result.items).toEqual([]);
  });

  it("givenScopeParam_whenCompletingWhereBar_thenOffersTableColumns", async () => {
    const result = await postgres.complete(
      { text: "cust", offset: 4, scope: { path: PUBLIC, relation: "orders" } },
      fakeCatalog(),
    );

    expect(result).toMatchObject({ from: 0, to: 4 });
    expect(labels(result, "column")).toEqual(["id", "customer_id", "total"]);
  });

  it("givenScopeOnQuotedRelation_whenCompletingWhereBar_thenOffersItsColumns", async () => {
    const result = await postgres.complete(
      { text: "", offset: 0, scope: { path: PUBLIC, relation: "Line Items" } },
      fakeCatalog(),
    );

    expect(labels(result, "column")).toEqual(["id", "sku"]);
  });

  it("givenUpperCaseUnquotedName_whenCompletingPostgres_thenFoldsToLowerCase", async () => {
    const result = await complete("SELECT O.| FROM ORDERS O");

    expect(labels(result)).toEqual(["id", "customer_id", "total"]);
  });

  it("givenWideSchema_whenCompletingFrom_thenAnswersUnder100ms", async () => {
    const wide: Relation[] = Array.from({ length: WIDE_TABLES }, (_, table) =>
      relation(
        `table_${String(table)}`,
        Array.from({ length: WIDE_COLUMNS }, (__, index) => [`column_${String(index)}`, "integer"] as const),
      ),
    );
    const catalog = fakeCatalog(new Map([[JSON.stringify(PUBLIC), wide]]));
    await complete("SELECT * FROM |", postgres, catalog);

    const started = performance.now();
    const result = await complete("SELECT * FROM |", postgres, catalog);
    const elapsed = performance.now() - started;

    expect(labels(result, "table")).toHaveLength(WIDE_TABLES);
    expect(elapsed).toBeLessThan(WIDE_BUDGET_MS);
  });
});

describe("sqlCompleter.resolve", () => {
  function resolve(marked: string, completer = postgres) {
    return completer.resolve(at(marked), fakeCatalog());
  }

  it("givenAliasReference_whenResolving_thenReturnsDeclarationSpan", async () => {
    const text = "SELECT o.id FROM orders o";
    const declaration = await resolve("SELECT |o.id FROM orders o");

    expect(declaration).toEqual({ kind: "alias", from: text.indexOf("orders"), to: text.length });
  });

  it("givenCteReference_whenResolving_thenReturnsCteName", async () => {
    const declaration = await resolve("WITH recent AS (SELECT 1) SELECT * FROM rec|ent");

    expect(declaration).toEqual({ kind: "cte", from: 5, to: 11 });
  });

  it("givenRelationReference_whenResolving_thenReturnsPathAndRelation", async () => {
    const declaration = await resolve("SELECT * FROM cust|omers");

    expect(declaration).toEqual({ kind: "relation", path: PUBLIC, relation: "customers" });
  });

  it("givenQualifiedRelation_whenResolving_thenReturnsItsNamespace", async () => {
    const declaration = await resolve("SELECT * FROM archive.old_|orders");

    expect(declaration).toEqual({ kind: "relation", path: ARCHIVE, relation: "old_orders" });
  });

  it("givenQuotedRelation_whenResolving_thenReturnsCatalogName", async () => {
    const declaration = await resolve('SELECT * FROM "Line |Items"');

    expect(declaration).toEqual({ kind: "relation", path: PUBLIC, relation: "Line Items" });
  });

  it("givenQualifiedColumn_whenResolving_thenReturnsColumn", async () => {
    const declaration = await resolve("SELECT o.tot|al FROM orders o");

    expect(declaration).toEqual({ kind: "column", path: PUBLIC, relation: "orders", column: "total" });
  });

  it("givenBareColumn_whenResolving_thenReturnsColumnOfInScopeRelation", async () => {
    const declaration = await resolve("SELECT email| FROM customers");

    expect(declaration).toEqual({ kind: "column", path: PUBLIC, relation: "customers", column: "email" });
  });

  it("givenUnknownName_whenResolving_thenNull", async () => {
    expect(await resolve("SELECT * FROM nowh|ere")).toBeNull();
    expect(await resolve("SELECT 'cust|omers'")).toBeNull();
    expect(await resolve("SELECT * FROM orders |")).toBeNull();
  });
});

describe("sqlCompleter follows the script's namespace statements", () => {
  const MYSQL_HOME = ["table_craft"] as const;
  const MYSQL_ARCHIVE = ["archive"] as const;
  const followingPostgres = sqlCompleter({
    dialect: { dollarQuotes: true, namespaceStatements: ["searchPath"] },
    identifierFolding: "lower",
    plainIdentifier: /^[a-z_][a-z0-9_$]*$/,
    quoteIdentifier: quoteIdentifierWith('"'),
    keywords: SQL_KEYWORDS,
    functions: SQL_FUNCTIONS,
  });
  const followingMysql = sqlCompleter({
    dialect: { backslashEscapes: true, hashComments: true, namespaceStatements: ["use"] },
    identifierFolding: "none",
    plainIdentifier: /^[A-Za-z_][A-Za-z0-9_$]*$/,
    quoteIdentifier: quoteIdentifierWith("`"),
    keywords: SQL_KEYWORDS,
    functions: SQL_FUNCTIONS,
  });

  function mysqlCatalog() {
    const relations = fixtureRelations();
    return fakeCatalog(
      new Map([
        [JSON.stringify(MYSQL_HOME), relations.get(JSON.stringify(PUBLIC)) ?? []],
        [JSON.stringify(MYSQL_ARCHIVE), relations.get(JSON.stringify(ARCHIVE)) ?? []],
      ]),
      MYSQL_HOME,
    );
  }

  it("givenUseAboveCaret_whenCompletingFrom_thenOffersThatDatabase", async () => {
    const result = await complete("USE archive;\n\nSELECT * FROM |", followingMysql, mysqlCatalog());

    expect(labels(result, "table")).toEqual(["old_orders"]);
    expect(labels(result, "namespace")).toEqual(["table_craft"]);
  });

  it("givenTwoUsesAboveCaret_whenCompletingFrom_thenNearestWins", async () => {
    const result = await complete("USE table_craft;\nUSE `archive`;\nSELECT * FROM |", followingMysql, mysqlCatalog());

    expect(labels(result, "table")).toEqual(["old_orders"]);
  });

  it("givenUseBelowCaret_whenCompletingFrom_thenIgnored", async () => {
    const result = await complete("SELECT * FROM |;\nUSE archive;", followingMysql, mysqlCatalog());

    expect(labels(result, "table")).toEqual(["Line Items", "customers", "orders"]);
  });

  it("givenUseOfUnknownDatabase_whenCompletingFrom_thenCatalogCurrent", async () => {
    const result = await complete("USE nowhere;\nSELECT * FROM |", followingMysql, mysqlCatalog());

    expect(labels(result, "table")).toEqual(["Line Items", "customers", "orders"]);
  });

  it("givenSearchPathAboveCaret_whenCompletingFrom_thenFirstExistingSchemaWins", async () => {
    const result = await complete("SET search_path TO nowhere, archive, public;\nSELECT * FROM |", followingPostgres);

    expect(labels(result, "table")).toEqual(["old_orders"]);
  });

  it("givenQuotedSearchPathNotMatchingCase_whenCompletingFrom_thenCatalogCurrent", async () => {
    const result = await complete('SET search_path TO "ARCHIVE";\nSELECT * FROM |', followingPostgres);

    expect(labels(result, "table")).toEqual(["Line Items", "customers", "orders"]);
  });

  it("givenSearchPathNamingTheDatabase_whenCompletingFrom_thenCatalogCurrent", async () => {
    const schemas = fakeCatalog();
    const database: Namespace = {
      path: ["table_craft"],
      name: "table_craft",
      kind: "database",
      system: false,
      current: false,
    };
    const catalog = { ...schemas, namespaces: async () => [database, ...(await schemas.namespaces())] };
    const result = await complete("SET search_path TO table_craft;\nSELECT * FROM |", followingPostgres, catalog);

    expect(labels(result, "table")).toEqual(["Line Items", "customers", "orders"]);
  });

  it("givenSearchPathDefault_whenCompletingFrom_thenCatalogCurrent", async () => {
    const result = await complete(
      "SET search_path TO archive;\nSET search_path TO DEFAULT;\nSELECT * FROM |",
      followingPostgres,
    );

    expect(labels(result, "table")).toEqual(["Line Items", "customers", "orders"]);
  });

  it("givenCatalogCurrentOverridden_whenNoScriptStatement_thenCompletesAgainstIt", async () => {
    const catalog = { ...fakeCatalog(), current: ARCHIVE };
    const result = await complete("SELECT * FROM |", followingPostgres, catalog);

    expect(labels(result, "table")).toEqual(["old_orders"]);
  });

  it("givenSearchPathAboveCaret_whenCompletingColumns_thenResolvesUnqualifiedRelationThere", async () => {
    const result = await complete("SET SCHEMA 'archive';\nSELECT | FROM old_orders", followingPostgres);

    expect(labels(result, "column")).toEqual(["id", "customer_id"]);
  });

  it("givenUseAboveCaret_whenResolving_thenRelationInThatDatabase", async () => {
    const declaration = await followingMysql.resolve(at("USE archive;\nSELECT * FROM old_ord|ers"), mysqlCatalog());

    expect(declaration).toEqual({ kind: "relation", path: MYSQL_ARCHIVE, relation: "old_orders" });
  });

  it("givenScopeRequest_whenTextLooksLikeUse_thenScopeUnaffected", async () => {
    const result = await followingMysql.complete(
      { text: "USE archive; ", offset: 13, scope: { path: MYSQL_HOME, relation: "orders" } },
      mysqlCatalog(),
    );

    expect(result.items.some((entry) => entry.label === "old_orders")).toBe(false);
  });
});

describe("sqlCompleter in a namespace statement's target", () => {
  const usingMysql = sqlCompleter({
    dialect: { backslashEscapes: true, hashComments: true, namespaceStatements: ["use"] },
    identifierFolding: "none",
    plainIdentifier: /^[A-Za-z_][A-Za-z0-9_$]*$/,
    quoteIdentifier: quoteIdentifierWith("`"),
    keywords: SQL_KEYWORDS,
    functions: SQL_FUNCTIONS,
  });
  const searchingPostgres = sqlCompleter({
    dialect: { dollarQuotes: true, namespaceStatements: ["searchPath"] },
    identifierFolding: "lower",
    plainIdentifier: /^[a-z_][a-z0-9_$]*$/,
    quoteIdentifier: quoteIdentifierWith('"'),
    keywords: SQL_KEYWORDS,
    functions: SQL_FUNCTIONS,
  });

  function database(name: string, system = false): Namespace {
    return { path: [name], name, kind: "schema", system, current: name === "table_craft" };
  }

  function mysqlCatalog() {
    const base = fakeCatalog(new Map(), ["table_craft"]);
    const databases = [
      database("information_schema", true),
      database("table_craft"),
      database("my db`s"),
      database("archive"),
    ];
    return { ...base, namespaces: () => Promise.resolve(databases) };
  }

  it("givenUse_whenCompleted_thenDatabasesSystemLastCurrentMarked", async () => {
    const result = await complete("USE |", usingMysql, mysqlCatalog());

    expect(result.items.map((entry) => entry.kind)).toEqual(["namespace", "namespace", "namespace", "namespace"]);
    expect(ranked(result)).toEqual(["archive", "my db`s", "table_craft", "information_schema"]);
    expect(result.items.find((entry) => entry.label === "table_craft")?.detail).toBe("current");
    expect(result.items.find((entry) => entry.label === "my db`s")?.apply).toBe("`my db``s`");
    expect(result).toMatchObject({ from: 4, to: 4, validFor: "^[A-Za-z0-9_$]*$" });
  });

  it("givenUsePartial_whenCompleted_thenFromWordStart", async () => {
    const result = await complete("SELECT 1;\nUSE arc|", usingMysql, mysqlCatalog());

    expect(result).toMatchObject({ from: 14, to: 17 });
    expect(labels(result)).toContain("archive");
    expect(labels(result, "keyword")).toEqual([]);
  });

  it("givenUseInBacktick_whenCompleted_thenBareNameClosed", async () => {
    const result = await complete("USE `my|", usingMysql, mysqlCatalog());

    expect(result).toMatchObject({ from: 5, to: 7, validFor: null });
    expect(result.items.find((entry) => entry.label === "my db`s")?.apply).toBe("my db``s`");
    expect(result.items.find((entry) => entry.label === "archive")?.apply).toBe("archive`");
  });

  it("givenSearchPathTo_whenCompleted_thenSchemasOnlyNoKeywords", async () => {
    const result = await complete("SET search_path TO |", searchingPostgres);

    expect(labels(result)).toEqual(["public", "archive"]);
    expect(result.items.find((entry) => entry.label === "public")?.detail).toBe("current");
    expect((await complete("SET SCHEMA |", searchingPostgres)).items.length).toBe(2);
  });

  it("givenSearchPathSecond_whenCompleted_thenListedLeftOut", async () => {
    const result = await complete("SET search_path TO Archive, |", searchingPostgres);

    expect(labels(result)).toEqual(["public"]);
  });

  it("givenSearchPathString_whenCompleted_thenInsideString", async () => {
    const result = await complete("SET search_path TO 'arc|", searchingPostgres);

    expect(result).toMatchObject({ from: 20, to: 23, validFor: null });
    expect(result.items.find((entry) => entry.label === "archive")?.apply).toBe("archive'");
  });

  it("givenSqliteUse_whenCompleted_thenNoNamespaces", async () => {
    const result = await complete("USE |", mysql, mysqlCatalog());

    expect(labels(result, "namespace")).toEqual([]);
  });
});

const RANGED_FUNCTIONS = [
  ...SQL_FUNCTIONS,
  ...functionSpecs("datetime", [
    ["DATE_FORMAT", "date, format -> string", "Writes a date using format specifiers."],
    ["NOW", "-> datetime", "The current date and time."],
  ]),
  ...functionSpecs("string", [
    ["LEFT", "str, length -> string", "The first characters of a string."],
    ["CEIL", "x -> integer", "Rounds up."],
    ["CHAR_LENGTH", "str -> integer", "Characters in a string."],
  ]),
  ...functionSpecs("encryption", [["PASSWORD", "str -> string", "An old password hash.", { mysql: "<8.0" }]]),
];

const ranged = sqlCompleter({
  dialect: { backslashEscapes: true, hashComments: true },
  identifierFolding: "none",
  plainIdentifier: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  quoteIdentifier: quoteIdentifierWith("`"),
  keywords: SQL_KEYWORDS,
  functions: RANGED_FUNCTIONS,
  server: (version) => {
    const triple = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    return triple === null ? null : { flavour: "mysql", version: triple.slice(1).map(Number) };
  },
});

describe("function specs in completion", () => {
  it("givenSpecFunction_whenCompleting_thenSignatureInfoAndCaret", async () => {
    const result = await complete("SELECT date_f| FROM orders", ranged);
    const item = result.items.find((candidate) => candidate.label === "date_format");

    expect(item).toMatchObject({
      kind: "function",
      detail: "(date, format) → string",
      apply: "date_format()",
      caret: "date_format(".length,
    });
    expect(item?.info).toBe("date_format(date, format) → string\n\nWrites a date using format specifiers.");
  });

  it("givenZeroArgumentFunction_whenCompleting_thenCaretAfterParentheses", async () => {
    const result = await complete("SELECT no| FROM orders", ranged);

    expect(result.items.find((item) => item.label === "now")).toMatchObject({ apply: "now()", caret: null });
  });

  it("givenOverloads_whenCompleting_thenInfoListsEachAndDetailTheFirst", async () => {
    const result = await complete("SELECT cou| FROM orders", ranged);
    const count = result.items.find((item) => item.label === "count");

    expect(count?.detail).toBe("(*) → integer");
    expect(count?.info?.split("\n").slice(0, 2)).toEqual(["count(*) → integer", "count(expr) → integer"]);
  });

  it("givenKeywordNamedFunction_whenInExpression_thenOfferedOnceAsFunction", async () => {
    const result = await complete("SELECT le| FROM orders", ranged);

    expect(result.items.filter((item) => item.label.toUpperCase() === "LEFT").map((item) => item.kind)).toEqual([
      "function",
    ]);
    const keywords = await complete("SELECT * FROM orders o |", ranged);
    expect(labels(keywords, "keyword")).toContain("LEFT");
  });

  it("givenServerVersion_whenCompleting_thenOnlyFunctionsInItsRange", async () => {
    const at84 = await complete("SELECT pass| FROM orders", ranged, fakeCatalog(undefined, PUBLIC, "8.4.3"));
    const at57 = await complete("SELECT pass| FROM orders", ranged, fakeCatalog(undefined, PUBLIC, "5.7.44-log"));
    const unknown = await complete("SELECT pass| FROM orders", ranged);

    expect(labels(at84, "function")).not.toContain("password");
    expect(labels(at57, "function")).toContain("password");
    expect(labels(unknown, "function")).toContain("password");
  });

  it("givenColumnPrefix_whenManyFunctions_thenColumnsRankFirst", async () => {
    const catalog = fakeCatalog(
      new Map([
        [
          JSON.stringify(PUBLIC),
          [
            relation("orders", [
              ["created_at", "datetime"],
              ["customer_id", "int"],
            ]),
          ],
        ],
      ]),
    );
    const result = await complete("SELECT c| FROM orders", ranged, catalog);

    expect(ranked(result).slice(0, 2)).toEqual(["created_at", "customer_id"]);
    expect(ranked(result).indexOf("ceil")).toBeGreaterThan(1);
    expect(ranked(result).indexOf("char_length")).toBeGreaterThan(1);
  });

  it("givenPlainNames_whenCompleting_thenItemsCarryNoInfoNorCaret", async () => {
    const plain = sqlCompleter({
      dialect: {},
      identifierFolding: "none",
      plainIdentifier: /^[A-Za-z_]\w*$/,
      quoteIdentifier: quoteIdentifierWith('"'),
      keywords: SQL_KEYWORDS,
      functions: ["my_func"],
    });
    const result = await complete("SELECT my| FROM orders", plain);

    expect(result.items.find((item) => item.label === "my_func")).toMatchObject({
      apply: "my_func",
      info: null,
      caret: null,
    });
  });
});
