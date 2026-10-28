/**
 * The function names of the "SQL Functions" chapter of the Oracle SQL Language Reference, from the
 * tables of contents of https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/toc.htm,
 * https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/toc.htm and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/toc.htm.
 *
 * One name per function: a page per form (ROUND (date), ROUND (number)) is one name, a page that
 * groups functions (CORR_*, REGR_, STATS_T_TEST_*, EMPTY_BLOB, EMPTY_CLOB, the vector distances) is
 * spelled out, and the calendar, fiscal and retail pages, which each describe a family, list the
 * members 23.26's V$SQLFN_METADATA names. Pages on format models rather than functions are left out.
 */

const LEVELS = ["YEAR", "QUARTER", "MONTH", "WEEK", "DAY"];
const PERIODS = ["YEAR", "QUARTER", "MONTH", "WEEK"];
const PARTS = [
  "DAY_OF_WEEK",
  "DAY_OF_MONTH",
  "DAY_OF_QUARTER",
  "DAY_OF_YEAR",
  "WEEK_OF_YEAR",
  "MONTH_OF_QUARTER",
  "MONTH_OF_YEAR",
  "QUARTER_OF_YEAR",
];

function calendarFamily(prefix: string, parts: readonly string[]): string[] {
  return [
    ...LEVELS.map((level) => `${prefix}_${level}`),
    ...LEVELS.map((level) => `${prefix}_ADD_${level}S`),
    ...PERIODS.flatMap((period) => [`${prefix}_${period}_START_DATE`, `${prefix}_${period}_END_DATE`]),
    ...parts.map((part) => `${prefix}_${part}`),
    `${prefix}_YEAR_NUMBER`,
  ];
}

export const MANUAL_INDEX: readonly string[] = [
  ...["ABS", "ACOS", "ADD_MONTHS", "ANY_VALUE", "APPROX_COUNT", "APPROX_COUNT_DISTINCT"],
  ...["APPROX_COUNT_DISTINCT_AGG", "APPROX_COUNT_DISTINCT_DETAIL", "APPROX_MEDIAN", "APPROX_PERCENTILE"],
  ...["APPROX_PERCENTILE_AGG", "APPROX_PERCENTILE_DETAIL", "APPROX_RANK", "APPROX_SUM", "ASCII", "ASCIISTR"],
  ...["ASIN", "ATAN", "ATAN2", "AVG", "BFILENAME", "BIN_TO_NUM", "BITAND", "BITMAP_BIT_POSITION"],
  ...["BITMAP_BUCKET_NUMBER", "BITMAP_CONSTRUCT_AGG", "BITMAP_COUNT", "BITMAP_OR_AGG", "BIT_AND_AGG"],
  ...["BIT_OR_AGG", "BIT_XOR_AGG", "BOOLEAN_AND_AGG", "BOOLEAN_OR_AGG"],
  ...calendarFamily("CALENDAR", PARTS),
  "CALENDAR_SINCE",
  ...["CARDINALITY", "CAST", "CEIL", "CHARTOROWID", "CHECKSUM", "CHR", "CLUSTER_DETAILS", "CLUSTER_DISTANCE"],
  ...["CLUSTER_ID", "CLUSTER_PROBABILITY", "CLUSTER_SET", "COALESCE", "COLLATION", "COLLECT", "COMPOSE"],
  ...["CONCAT", "CONVERT", "CON_DBID_TO_ID", "CON_GUID_TO_ID", "CON_ID_TO_CON_NAME", "CON_ID_TO_DBID"],
  ...["CON_ID_TO_GUID", "CON_ID_TO_UID", "CON_NAME_TO_ID", "CON_UID_TO_ID", "CORR", "CORR_K", "CORR_S"],
  ...["COS", "COSH", "COSINE_DISTANCE", "COUNT", "COVAR_POP", "COVAR_SAMP", "CUBE_TABLE", "CUME_DIST"],
  ...["CUMULATE", "CURRENT_DATE", "CURRENT_TIMESTAMP", "CV", "DATAOBJ_TO_MAT_PARTITION"],
  ...["DATAOBJ_TO_PARTITION", "DATEADD", "DATEDIFF", "DBTIMEZONE", "DECODE", "DECOMPOSE", "DENSE_RANK"],
  ...["DEPTH", "DEREF", "DOMAIN_CHECK", "DOMAIN_CHECK_TYPE", "DOMAIN_DISPLAY", "DOMAIN_NAME", "DOMAIN_ORDER"],
  ...["DUMP", "EMPTY_BLOB", "EMPTY_CLOB", "EVERY", "EXISTSNODE", "EXP", "EXTRACT", "EXTRACTVALUE"],
  ...["FEATURE_COMPARE", "FEATURE_DETAILS", "FEATURE_ID", "FEATURE_SET", "FEATURE_VALUE", "FIRST"],
  "FIRST_VALUE",
  ...calendarFamily("FISCAL", PARTS),
  ...["FLOOR", "FROM_TZ", "FROM_VECTOR", "GRAPHQL", "GREATEST", "GROUPING", "GROUPING_ID", "GROUP_ID"],
  ...["HEXTORAW", "HOP", "INITCAP", "INNER_PRODUCT", "INSTR", "IS_UUID", "ITERATION_NUMBER", "JSON"],
  ...["JSON_ARRAY", "JSON_ARRAYAGG", "JSON_DATAGUIDE", "JSON_MERGEPATCH", "JSON_OBJECT", "JSON_OBJECTAGG"],
  ...["JSON_QUERY", "JSON_SCALAR", "JSON_SERIALIZE", "JSON_TABLE", "JSON_TRANSFORM", "JSON_VALUE"],
  ...["KURTOSIS_POP", "KURTOSIS_SAMP", "L1_DISTANCE", "L2_DISTANCE", "LAG", "LAST", "LAST_DAY", "LAST_VALUE"],
  ...["LEAD", "LEAST", "LENGTH", "LISTAGG", "LN", "LNNVL", "LOCALTIMESTAMP", "LOG", "LOWER", "LPAD", "LTRIM"],
  ...["MAKE_REF", "MAX", "MEDIAN", "MIN", "MOD", "MONTHS_BETWEEN", "NANVL", "NCHR", "NEW_TIME", "NEXT_DAY"],
  ...["NLSSORT", "NLS_CHARSET_DECL_LEN", "NLS_CHARSET_ID", "NLS_CHARSET_NAME", "NLS_COLLATION_ID"],
  ...["NLS_COLLATION_NAME", "NLS_INITCAP", "NLS_LOWER", "NLS_UPPER", "NTH_VALUE", "NTILE", "NULLIF"],
  ...["NUMTODSINTERVAL", "NUMTOYMINTERVAL", "NVL", "NVL2", "ORA_CHECK_DATA_PRIVILEGE", "ORA_DM_PARTITION_NAME"],
  ...["ORA_DST_AFFECTED", "ORA_DST_CONVERT", "ORA_DST_ERROR", "ORA_END_USER_CONTEXT", "ORA_HASH"],
  ...["ORA_INVOKING_USER", "ORA_INVOKING_USERID", "ORA_IS_COLUMN_AUTHORIZED", "PATH", "PERCENTILE_CONT"],
  ...["PERCENTILE_DISC", "PERCENT_RANK", "POWER", "POWERMULTISET", "POWERMULTISET_BY_CARDINALITY"],
  ...["PREDICTION", "PREDICTION_BOUNDS", "PREDICTION_COST", "PREDICTION_DETAILS", "PREDICTION_PROBABILITY"],
  ...["PREDICTION_SET", "PRESENTNNV", "PRESENTV", "PREVIOUS", "RANK", "RATIO_TO_REPORT", "RAWTOHEX"],
  ...["RAWTONHEX", "RAW_TO_UUID", "REF", "REFTOHEX", "REGEXP_COUNT", "REGEXP_INSTR", "REGEXP_REPLACE"],
  ...["REGEXP_SUBSTR", "REGR_SLOPE", "REGR_INTERCEPT", "REGR_COUNT", "REGR_R2", "REGR_AVGX", "REGR_AVGY"],
  ...["REGR_SXX", "REGR_SYY", "REGR_SXY", "REMAINDER", "REPLACE"],
  ...calendarFamily("RETAIL", [...PARTS, "WEEK_OF_MONTH", "WEEK_OF_QUARTER"]),
  "RETAIL_DAY_EXISTS",
  ...["ROUND", "ROUND_TIES_TO_EVEN", "ROWIDTOCHAR", "ROWIDTONCHAR", "ROW_NUMBER", "RPAD", "RTRIM"],
  ...["SCN_TO_TIMESTAMP", "SESSIONS", "SESSIONTIMEZONE", "SET", "SIGN", "SIN", "SINH", "SKEWNESS_POP"],
  ...["SKEWNESS_SAMP", "SOUNDEX", "SQRT", "STANDARD_HASH", "STATS_BINOMIAL_TEST", "STATS_CROSSTAB"],
  ...["STATS_F_TEST", "STATS_KS_TEST", "STATS_MODE", "STATS_MW_TEST", "STATS_ONE_WAY_ANOVA"],
  ...["STATS_T_TEST_INDEP", "STATS_T_TEST_INDEPU", "STATS_T_TEST_ONE", "STATS_T_TEST_PAIRED", "STATS_WSR_TEST"],
  ...["STDDEV", "STDDEV_POP", "STDDEV_SAMP", "SUBSTR", "SUM", "SYSDATE", "SYSTIMESTAMP", "SYS_CONNECT_BY_PATH"],
  ...["SYS_CONTEXT", "SYS_DBURIGEN", "SYS_EXTRACT_UTC", "SYS_GUID", "SYS_OP_ZONE_ID", "SYS_ROW_ETAG"],
  ...["SYS_TYPEID", "SYS_XMLAGG", "SYS_XMLGEN", "TAN", "TANH", "TIMESTAMPDIFF", "TIMESTAMP_TO_SCN"],
  ...["TIME_BUCKET", "TO_APPROX_COUNT_DISTINCT", "TO_APPROX_PERCENTILE", "TO_BINARY_DOUBLE", "TO_BINARY_FLOAT"],
  ...["TO_BLOB", "TO_BOOLEAN", "TO_CHAR", "TO_CLOB", "TO_DATE", "TO_DSINTERVAL", "TO_LOB", "TO_MULTI_BYTE"],
  ...["TO_NCHAR", "TO_NCLOB", "TO_NUMBER", "TO_SINGLE_BYTE", "TO_TIMESTAMP", "TO_TIMESTAMP_TZ"],
  ...["TO_UTC_TIMESTAMP_TZ", "TO_VECTOR", "TO_YMINTERVAL", "TRANSLATE", "TREAT", "TRIM", "TRUNC", "TUMBLE"],
  ...["TZ_OFFSET", "UID", "UNISTR", "UPPER", "USER", "USERENV", "UUID", "UUID_TO_RAW", "VALIDATE_CONVERSION"],
  ...["VALUE", "VARIANCE", "VAR_POP", "VAR_SAMP", "VECTOR", "VECTOR_CHUNKS", "VECTOR_DIMENSION_COUNT"],
  ...["VECTOR_DIMENSION_FORMAT", "VECTOR_DIMS", "VECTOR_DISTANCE", "VECTOR_EMBEDDING", "VECTOR_NORM"],
  ...["VECTOR_SERIALIZE", "VSIZE", "WIDTH_BUCKET", "XMLAGG", "XMLCAST", "XMLCDATA", "XMLCOLATTVAL"],
  ...["XMLCOMMENT", "XMLCONCAT", "XMLDIFF", "XMLELEMENT", "XMLEXISTS", "XMLFOREST", "XMLISVALID", "XMLPARSE"],
  ...["XMLPATCH", "XMLPI", "XMLQUERY", "XMLROOT", "XMLSEQUENCE", "XMLSERIALIZE", "XMLTABLE", "XMLTRANSFORM"],
];

/** Names of the chapter the completer leaves out, each with why. */
export const NOT_OFFERED: Readonly<Record<string, string>> = {
  FIRST:
    "Not called by its name: it is the KEEP (DENSE_RANK FIRST ORDER BY ...) modifier of another aggregate, so FIRST( would never be valid.",
  LAST: "Not called by its name: it is the KEEP (DENSE_RANK LAST ORDER BY ...) modifier of another aggregate, so LAST( would never be valid.",
  SET: "SET is a reserved word the completer offers as a keyword after UPDATE ... ; offering SET( there would write a call where the SET clause goes.",
};
