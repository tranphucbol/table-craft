import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { NOT_IN_AZURE, SQL_SERVER_2022, SQL_SERVER_2025 } from "./ranges.js";

/**
 * Rowset, graph, vector and AI functions, summarised in our own words from
 * https://learn.microsoft.com/en-us/sql/t-sql/functions/opendatasource-transact-sql and its
 * rowset siblings, .../graph-functions-transact-sql, .../vector-functions-transact-sql and
 * .../ai-generate-embeddings-transact-sql.
 */
export const MISC_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("misc", [
  [
    "GENERATE_SERIES",
    "start, stop, step? -> table",
    "A row for each number from start to stop, by step.",
    SQL_SERVER_2022,
  ],
  [
    "OPENDATASOURCE",
    "provider, connection_string -> table",
    "Reaches another server by OLE DB without a linked server.",
    NOT_IN_AZURE,
  ],
  ["OPENJSON", "json, path? -> table", "The JSON document's items as rows; WITH names the columns."],
  ["OPENQUERY", "linked_server, query -> table", "Runs a query on a linked server and reads its rows.", NOT_IN_AZURE],
  [
    "OPENROWSET",
    ["provider, connection, query -> table", "BULK data_file -> table"],
    "Reads rows from an OLE DB source or a file.",
    NOT_IN_AZURE,
  ],
  [
    "OPENXML",
    "document_handle, rowpattern, flags? -> table",
    "An XML document that sp_xml_preparedocument parsed, as rows.",
  ],
  ["PREDICT", "MODEL model, DATA source -> table", "Scores rows with a stored machine learning model.", NOT_IN_AZURE],
  [
    "STRING_SPLIT",
    "string, separator, enable_ordinal? -> table",
    "A row for each piece of the string between separators.",
  ],
  ["EDGE_ID_FROM_PARTS", "object_id, id -> string", "A graph edge id from its table's object id and its own id."],
  ["GRAPH_ID_FROM_EDGE_ID", "edge_id -> bigint", "The internal graph id within an edge id."],
  ["GRAPH_ID_FROM_NODE_ID", "node_id -> bigint", "The internal graph id within a node id."],
  ["NODE_ID_FROM_PARTS", "object_id, id -> string", "A graph node id from its table's object id and its own id."],
  ["OBJECT_ID_FROM_EDGE_ID", "edge_id -> integer", "The object id of the table an edge id belongs to."],
  ["OBJECT_ID_FROM_NODE_ID", "node_id -> integer", "The object id of the table a node id belongs to."],
  [
    "VECTOR_DISTANCE",
    "metric, vector, vector -> float",
    "The distance between two vectors: 'cosine', 'euclidean' or 'dot'.",
    SQL_SERVER_2025,
  ],
  ["VECTOR_NORM", "vector, norm -> float", "The length of a vector by a norm such as 'norm2'.", SQL_SERVER_2025],
  ["VECTOR_NORMALIZE", "vector, norm -> vector", "The vector scaled to length 1 by a norm.", SQL_SERVER_2025],
  ["VECTORPROPERTY", "vector, property -> any", "A property of a vector, such as its dimensions.", SQL_SERVER_2025],
  [
    "VECTOR_SEARCH",
    "TABLE source, COLUMN vector_column, SIMILAR_TO query_vector, METRIC metric, TOP_N count -> table",
    "The rows nearest a vector, through a vector index.",
    SQL_SERVER_2025,
  ],
  [
    "AI_GENERATE_CHUNKS",
    "SOURCE text, CHUNK_TYPE chunk_type, CHUNK_SIZE size -> table",
    "Splits text into chunks, a row each, for embedding.",
    SQL_SERVER_2025,
  ],
  [
    "AI_GENERATE_EMBEDDINGS",
    "source USE model -> vector",
    "An embedding of the text from an external model the database names, written USE MODEL name.",
    SQL_SERVER_2025,
  ],
]);
