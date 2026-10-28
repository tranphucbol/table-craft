import { functionSpecs, type FunctionEntry, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { FROM_23 } from "./ranges.js";

const DISTANCES: readonly (readonly [string, string])[] = [
  ["L1_DISTANCE", "The Manhattan distance between two vectors."],
  ["L2_DISTANCE", "The Euclidean distance between two vectors."],
  ["COSINE_DISTANCE", "One minus the cosine of the angle between two vectors."],
  ["INNER_PRODUCT", "The dot product of two vectors."],
];

const DISTANCE_ENTRIES: readonly FunctionEntry[] = DISTANCES.map(([name, summary]) => [
  name,
  "a, b -> number",
  summary,
  FROM_23,
]);

/**
 * Machine learning, vector, domain and UUID functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Single-Row-Functions.html.
 */
export const VECTOR_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("misc", [
  [
    "CLUSTER_DETAILS",
    "model, cluster?, top? USING attributes -> xmltype",
    "Which attributes weigh most in placing a row in a clustering model's clusters.",
  ],
  ["CLUSTER_DISTANCE", "model, cluster? USING attributes -> number", "How far a row lies from a cluster's centroid."],
  ["CLUSTER_ID", "model USING attributes -> number", "The cluster a clustering model places the row in."],
  ["CLUSTER_PROBABILITY", "model, cluster? USING attributes -> number", "How likely the row belongs to a cluster."],
  [
    "CLUSTER_SET",
    "model, top?, cutoff? USING attributes -> collection",
    "The clusters the row may belong to, each with its probability.",
  ],
  ...DISTANCE_ENTRIES,
  [
    "DOMAIN_CHECK",
    "domain, expr... -> boolean",
    "Whether values pass a data use case domain's type and constraints.",
    FROM_23,
  ],
  [
    "DOMAIN_CHECK_TYPE",
    "domain, expr... -> boolean",
    "Whether values convert to a domain's types, without checking its constraints.",
    FROM_23,
  ],
  ["DOMAIN_DISPLAY", "expr... -> string", "Domain values written by the domain's display expression.", FROM_23],
  ["DOMAIN_NAME", "expr... -> string", "The qualified name of the domain a column belongs to.", FROM_23],
  ["DOMAIN_ORDER", "expr... -> any", "Domain values as the domain's order expression sorts them.", FROM_23],
  [
    "FEATURE_COMPARE",
    "model USING attributes -> number",
    "How alike two inputs are under a feature extraction model; the second follows AND USING.",
  ],
  [
    "FEATURE_DETAILS",
    "model, feature?, top? USING attributes -> xmltype",
    "Which attributes weigh most in a feature extraction model's features for the row.",
  ],
  ["FEATURE_ID", "model USING attributes -> number", "The feature with the highest value for the row."],
  [
    "FEATURE_SET",
    "model, top?, cutoff? USING attributes -> collection",
    "The features of the row, each with its value.",
  ],
  [
    "FEATURE_VALUE",
    "model, feature? USING attributes -> number",
    "The value of a feature, or the highest one, for the row.",
  ],
  [
    "FROM_VECTOR",
    ["vector -> string", "vector RETURNING type -> string"],
    "A vector as text, dense or sparse.",
    FROM_23,
  ],
  ["IS_UUID", "text, version? -> boolean", "Whether text is a well-formed UUID, of a given version if named.", FROM_23],
  [
    "ORA_DM_PARTITION_NAME",
    "model USING attributes -> string",
    "Which partition of a partitioned machine learning model scores the row.",
  ],
  [
    "PREDICTION",
    "model, cost_model? USING attributes -> any",
    "The best prediction a classification, regression or anomaly model makes for the row.",
  ],
  [
    "PREDICTION_BOUNDS",
    "model, confidence?, class? USING attributes -> object",
    "The lower and upper bounds of a GLM model's prediction.",
  ],
  ["PREDICTION_COST", "model, class? USING attributes -> number", "The cost of a classification model's prediction."],
  [
    "PREDICTION_DETAILS",
    "model, class?, top? USING attributes -> xmltype",
    "Which attributes weigh most in a model's prediction for the row.",
  ],
  [
    "PREDICTION_PROBABILITY",
    "model, class? USING attributes -> number",
    "How likely a classification model's prediction, or another class, is.",
  ],
  [
    "PREDICTION_SET",
    "model, best?, cutoff? USING attributes -> collection",
    "The classes a model predicts for the row, each with its probability.",
  ],
  ["RAW_TO_UUID", "raw -> string", "A RAW(16) UUID written in its canonical 36-character form.", FROM_23],
  [
    "TO_VECTOR",
    "expr, dimensions?, format?, storage? -> vector",
    "Text such as '[1, 2.5]', a JSON array or a BLOB read as a VECTOR.",
    FROM_23,
  ],
  ["UUID", "version?, namespace?, name? -> raw", "A new UUID as RAW(16), version 4 unless another is named.", FROM_23],
  ["UUID_TO_RAW", "text -> raw", "A UUID in text, with or without hyphens and braces, as RAW(16).", FROM_23],
  ["VECTOR", "expr, dimensions?, format?, storage? -> vector", "Another name for TO_VECTOR.", FROM_23],
  [
    "VECTOR_CHUNKS",
    "text BY mode -> table",
    "Text split into chunks by words, characters or vocabulary tokens, for embedding; for the FROM clause.",
    FROM_23,
  ],
  ["VECTOR_DIMENSION_COUNT", "vector -> number", "How many dimensions a vector has.", FROM_23],
  [
    "VECTOR_DIMENSION_FORMAT",
    "vector -> string",
    "The number format of a vector's dimensions: INT8, FLOAT32, FLOAT64 or BINARY.",
    FROM_23,
  ],
  ["VECTOR_DIMS", "vector -> number", "Another name for VECTOR_DIMENSION_COUNT.", FROM_23],
  [
    "VECTOR_DISTANCE",
    "a, b, metric? -> number",
    "The distance between two vectors by a metric such as COSINE, EUCLIDEAN or DOT; cosine by default.",
    FROM_23,
  ],
  [
    "VECTOR_EMBEDDING",
    "model USING data AS DATA -> vector",
    "The vector an embedding model in the database computes for a value.",
    FROM_23,
  ],
  ["VECTOR_NORM", "vector -> number", "The Euclidean length of a vector.", FROM_23],
  [
    "VECTOR_SERIALIZE",
    ["vector -> string", "vector RETURNING type -> string"],
    "Another name for FROM_VECTOR.",
    FROM_23,
  ],
]);
