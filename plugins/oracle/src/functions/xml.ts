import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { BEFORE_23 } from "./ranges.js";

/**
 * XML functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/XML-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/XML-Functions.html.
 */
export const XML_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("xml", [
  [
    "DEPTH",
    "correlation -> number",
    "How many levels below the given folder an UNDER_PATH condition with the same correlation matched.",
  ],
  ["EXISTSNODE", "xml, xpath, namespace? -> number", "1 when an XPath selects any node, else 0 (deprecated)."],
  [
    "EXTRACTVALUE",
    "xml, xpath, namespace? -> string",
    "The scalar text of the one node an XPath selects (deprecated).",
  ],
  [
    "PATH",
    "correlation -> string",
    "The path an UNDER_PATH or EQUALS_PATH condition with the same correlation matched.",
  ],
  ["SYS_DBURIGEN", "column... -> dburitype", "A DBURIType that points at a column or row, to fetch it later by URL."],
  ["SYS_XMLAGG", "xml, format? -> xmltype", "The group's XML fragments wrapped in one ROWSET element."],
  ["SYS_XMLGEN", "expr, format? -> xmltype", "A value, row or object as an XML document with one ROW element."],
  ["XMLAGG", "xml -> xmltype", "The group's XML fragments joined into one, in an optional ORDER BY order."],
  ["XMLCAST", "value AS type -> any", "The value of an XML node as a SQL scalar type."],
  ["XMLCDATA", "text -> xmltype", "A CDATA section holding the text."],
  ["XMLCOLATTVAL", "value AS alias... -> xmltype", "A column element per argument, with the name in a name attribute."],
  ["XMLCOMMENT", "text -> xmltype", "An XML comment holding the text."],
  ["XMLCONCAT", "xml... -> xmltype", "Its XML arguments joined into one fragment."],
  ["XMLDIFF", "before, after, namespace?, flags? -> xmltype", "An Xdiff document of how two XML documents differ."],
  [
    "XMLELEMENT",
    ["name, content... -> xmltype", "NAME name, XMLATTRIBUTES attributes, content... -> xmltype"],
    "An XML element with a name, optional attributes and content.",
  ],
  ["XMLEXISTS", "xquery PASSING value -> boolean", "True when an XQuery expression returns any item."],
  ["XMLFOREST", "value AS alias... -> xmltype", "One element per argument, named by its alias or column."],
  ["XMLISVALID", "xml, schema_url?, element? -> number", "1 when a document is valid against an XML schema, else 0."],
  [
    "XMLPARSE",
    "DOCUMENT|CONTENT text -> xmltype",
    "Text parsed as an XML document or fragment, with WELLFORMED to skip checks.",
  ],
  ["XMLPATCH", "document, patch -> xmltype", "An XML document with an Xdiff patch applied."],
  ["XMLPI", "NAME target, value? -> xmltype", "An XML processing instruction."],
  ["XMLQUERY", "xquery PASSING value RETURNING CONTENT -> xmltype", "The result of an XQuery expression as XML."],
  [
    "XMLROOT",
    "xml, VERSION version, STANDALONE standalone? -> xmltype",
    "An XML value with a prolog naming its version and standalone status.",
    BEFORE_23,
  ],
  ["XMLSEQUENCE", "xml -> collection", "The top-level nodes of an XML value as a varray of XMLType."],
  [
    "XMLSERIALIZE",
    "DOCUMENT|CONTENT xml AS type -> string",
    "XML as text of a character type, with INDENT or other options.",
  ],
  [
    "XMLTABLE",
    "xquery PASSING value COLUMNS columns -> table",
    "Projects the items of an XQuery result into rows and columns, for the FROM clause.",
  ],
  ["XMLTRANSFORM", "xml, stylesheet -> xmltype", "An XML document transformed by an XSL stylesheet."],
]);
