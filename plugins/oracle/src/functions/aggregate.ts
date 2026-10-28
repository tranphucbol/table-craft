import { functionSpecs, type FunctionEntry, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { FROM_21, FROM_23 } from "./ranges.js";

const REGRESSIONS: readonly (readonly [string, string])[] = [
  ["REGR_SLOPE", "The slope of the least-squares line fitted through the (x, y) pairs."],
  ["REGR_INTERCEPT", "Where the least-squares line fitted through the (x, y) pairs crosses the y axis."],
  ["REGR_COUNT", "How many (x, y) pairs have neither side null."],
  ["REGR_R2", "The coefficient of determination of the least-squares fit."],
  ["REGR_AVGX", "The average of x over the pairs with neither side null."],
  ["REGR_AVGY", "The average of y over the pairs with neither side null."],
  ["REGR_SXX", "REGR_COUNT times VAR_POP of x, over the pairs with neither side null."],
  ["REGR_SYY", "REGR_COUNT times VAR_POP of y, over the pairs with neither side null."],
  ["REGR_SXY", "REGR_COUNT times COVAR_POP of x and y, over the pairs with neither side null."],
];

const REGRESSION_ENTRIES: readonly FunctionEntry[] = REGRESSIONS.map(([name, summary]) => [
  name,
  "y, x -> number",
  summary,
]);

/**
 * Aggregate, approximate and statistical functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Aggregate-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Aggregate-Functions.html.
 */
export const AGGREGATE_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("aggregate", [
  ["ANY_VALUE", "expr -> any", "Some value of the group, whichever is cheapest to return."],
  [
    "APPROX_COUNT",
    "expr, MAX_ERROR? -> number",
    "A quick approximate count, for a query that also ranks with APPROX_RANK; 'MAX_ERROR' gives its error bound.",
  ],
  [
    "APPROX_COUNT_DISTINCT",
    "expr -> number",
    "Roughly how many distinct values there are, much faster than COUNT(DISTINCT) on large data.",
  ],
  ["APPROX_COUNT_DISTINCT_AGG", "detail -> blob", "Merges APPROX_COUNT_DISTINCT_DETAIL results into a coarser detail."],
  [
    "APPROX_COUNT_DISTINCT_DETAIL",
    "expr -> blob",
    "A detail of approximate distinct counts, to store and aggregate later at a coarser level.",
  ],
  [
    "APPROX_MEDIAN",
    "expr, DETERMINISTIC?, ERROR_RATE|CONFIDENCE? -> number",
    "An approximate median, or its error rate or confidence.",
  ],
  [
    "APPROX_PERCENTILE",
    "percentile, DETERMINISTIC?, ERROR_RATE|CONFIDENCE? -> number",
    "An approximate percentile of the WITHIN GROUP (ORDER BY ...) values.",
  ],
  ["APPROX_PERCENTILE_AGG", "detail -> blob", "Merges APPROX_PERCENTILE_DETAIL results into a coarser detail."],
  [
    "APPROX_PERCENTILE_DETAIL",
    "expr, DETERMINISTIC? -> blob",
    "A detail of approximate percentiles, to store and aggregate later at a coarser level.",
  ],
  [
    "APPROX_RANK",
    "order_by -> number",
    "An approximate rank within a partition, for filtering the top values in a HAVING clause.",
  ],
  [
    "APPROX_SUM",
    "expr, MAX_ERROR? -> number",
    "A quick approximate sum, for a query that also ranks with APPROX_RANK; 'MAX_ERROR' gives its error bound.",
  ],
  ["AVG", ["expr -> number", "DISTINCT expr -> number"], "The average of the non-null values."],
  ["BIT_AND_AGG", "expr -> number", "The bitwise AND of the group's whole numbers.", FROM_21],
  ["BIT_OR_AGG", "expr -> number", "The bitwise OR of the group's whole numbers.", FROM_21],
  ["BIT_XOR_AGG", "expr -> number", "The bitwise XOR of the group's whole numbers.", FROM_21],
  [
    "BITMAP_BIT_POSITION",
    "n -> number",
    "Where a whole number falls within its bitmap bucket, for counting distinct values with bitmaps.",
  ],
  ["BITMAP_BUCKET_NUMBER", "n -> number", "Which bitmap bucket a whole number falls in."],
  ["BITMAP_CONSTRUCT_AGG", "bit_position -> blob", "Builds a bitmap from the group's bit positions."],
  ["BITMAP_COUNT", "bitmap -> number", "How many bits a bitmap has set."],
  ["BITMAP_OR_AGG", "bitmap -> blob", "Merges the group's bitmaps with OR."],
  ["BOOLEAN_AND_AGG", "condition -> boolean", "True when the condition holds for every row of the group.", FROM_23],
  ["BOOLEAN_OR_AGG", "condition -> boolean", "True when the condition holds for some row of the group.", FROM_23],
  [
    "CHECKSUM",
    ["expr -> number", "DISTINCT expr -> number"],
    "An order-independent checksum of the group's values, to notice when a table's data changed.",
    FROM_21,
  ],
  ["COLLECT", "expr -> collection", "The group's values as a nested table; CAST it to a named collection type."],
  ["CORR", "y, x -> number", "The Pearson correlation coefficient of the pairs."],
  ["CORR_K", "y, x, result? -> number", "Kendall's tau-b rank correlation, or its significance."],
  ["CORR_S", "y, x, result? -> number", "Spearman's rho rank correlation, or its significance."],
  [
    "COUNT",
    ["* -> number", "expr -> number", "DISTINCT expr -> number"],
    "How many rows, or non-null values, there are.",
  ],
  ["COVAR_POP", "y, x -> number", "The population covariance of the pairs."],
  ["COVAR_SAMP", "y, x -> number", "The sample covariance of the pairs."],
  ["EVERY", "condition -> boolean", "Another name for BOOLEAN_AND_AGG.", FROM_23],
  ["GROUP_ID", "-> number", "Numbers the repeats of a grouping that GROUP BY lists more than once, from 0."],
  ["GROUPING", "expr -> number", "1 when a ROLLUP or CUBE row totals over the column, else 0."],
  ["GROUPING_ID", "expr... -> number", "The GROUPING bits of several columns read as one number."],
  ["KURTOSIS_POP", ["expr -> number", "DISTINCT expr -> number"], "The population kurtosis of the values.", FROM_21],
  ["KURTOSIS_SAMP", ["expr -> number", "DISTINCT expr -> number"], "The sample kurtosis of the values.", FROM_21],
  [
    "LISTAGG",
    ["expr, delimiter? -> string", "DISTINCT expr, delimiter? -> string"],
    "The group's values joined into one string in the WITHIN GROUP (ORDER BY ...) order.",
  ],
  ["MAX", ["expr -> any", "DISTINCT expr -> any"], "The largest value."],
  ["MEDIAN", "expr -> number", "The middle value, interpolated between the two middle ones."],
  ["MIN", ["expr -> any", "DISTINCT expr -> any"], "The smallest value."],
  [
    "PERCENTILE_CONT",
    "fraction -> number",
    "The value at a fraction of the WITHIN GROUP (ORDER BY ...) order, interpolated between rows.",
  ],
  [
    "PERCENTILE_DISC",
    "fraction -> any",
    "The first value of the WITHIN GROUP (ORDER BY ...) order whose cumulative distribution reaches a fraction.",
  ],
  ...REGRESSION_ENTRIES,
  ["SKEWNESS_POP", ["expr -> number", "DISTINCT expr -> number"], "The population skewness of the values.", FROM_21],
  ["SKEWNESS_SAMP", ["expr -> number", "DISTINCT expr -> number"], "The sample skewness of the values.", FROM_21],
  [
    "STATS_BINOMIAL_TEST",
    "values, outcome, probability, result? -> number",
    "An exact binomial test of whether a success probability fits the data.",
  ],
  [
    "STATS_CROSSTAB",
    "a, b, result? -> number",
    "A chi-square test of whether two categorical columns are independent, or a related statistic.",
  ],
  ["STATS_F_TEST", "values, groups, result?, group? -> number", "An F-test of whether two groups have equal variance."],
  [
    "STATS_KS_TEST",
    "values, groups, result? -> number",
    "A Kolmogorov-Smirnov test of whether two samples come from the same distribution.",
  ],
  ["STATS_MODE", "expr -> any", "The most frequent value."],
  [
    "STATS_MW_TEST",
    "values, groups, result?, group? -> number",
    "A Mann-Whitney test of whether two independent samples come from the same distribution.",
  ],
  ["STATS_ONE_WAY_ANOVA", "groups, values, result? -> number", "A one-way analysis of variance across groups."],
  [
    "STATS_T_TEST_INDEP",
    "values, groups, result?, group? -> number",
    "A t-test of two independent groups with equal variances.",
  ],
  [
    "STATS_T_TEST_INDEPU",
    "values, groups, result?, group? -> number",
    "A t-test of two independent groups with unequal variances.",
  ],
  ["STATS_T_TEST_ONE", "values, mean?, result? -> number", "A t-test of one sample's mean against a value."],
  ["STATS_T_TEST_PAIRED", "first, second, result? -> number", "A t-test of the difference in paired values."],
  [
    "STATS_WSR_TEST",
    "first, second, result? -> number",
    "A Wilcoxon signed-rank test of whether paired samples differ.",
  ],
  ["STDDEV", ["expr -> number", "DISTINCT expr -> number"], "The sample standard deviation, 0 for one row."],
  ["STDDEV_POP", "expr -> number", "The population standard deviation."],
  ["STDDEV_SAMP", "expr -> number", "The sample standard deviation, null for one row."],
  ["SUM", ["expr -> number", "DISTINCT expr -> number"], "The total of the non-null values."],
  [
    "TO_APPROX_COUNT_DISTINCT",
    "detail -> number",
    "The approximate distinct count a stored APPROX_COUNT_DISTINCT_DETAIL holds.",
  ],
  [
    "TO_APPROX_PERCENTILE",
    "detail, percentile, type, ASC|DESC? -> number",
    "An approximate percentile read from a stored APPROX_PERCENTILE_DETAIL.",
  ],
  ["VAR_POP", "expr -> number", "The population variance."],
  ["VAR_SAMP", "expr -> number", "The sample variance, null for one row."],
  ["VARIANCE", ["expr -> number", "DISTINCT expr -> number"], "The sample variance, 0 for one row."],
]);
