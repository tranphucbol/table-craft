const DIGITS =
  "(SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";

/**
 * 10,000 rows from any SQL server without a table or a recursive CTE, which TiDB before 5.1 lacks:
 * enough that the first page leaves the cursor open with rows still on the wire.
 */
export function tenThousandRows(): string {
  return `SELECT a.n * 1000 + b.n * 100 + c.n * 10 + d.n AS n, REPEAT('x', 200) AS pad FROM ${DIGITS} a, ${DIGITS} b, ${DIGITS} c, ${DIGITS} d`;
}

/**
 * 100,000 rows, about 21 MB: more than Linux's autotuned socket buffers hold, which swallow all of
 * `tenThousandRows`, so the server is still writing when a test strands the link mid-result.
 */
export function hundredThousandRows(): string {
  return `SELECT a.n * 10000 + b.n * 1000 + c.n * 100 + d.n * 10 + e.n AS n, REPEAT('x', 200) AS pad FROM ${DIGITS} a, ${DIGITS} b, ${DIGITS} c, ${DIGITS} d, ${DIGITS} e`;
}
