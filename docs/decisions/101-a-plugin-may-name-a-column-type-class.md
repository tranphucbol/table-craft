# 101: A plugin may name a column's type class

Status: Accepted. Plugin API 1.0.0 (added before its first release tag, decision 106).

## Decision

`Column` gains an optional `typeClass?: TypeClass`, and `TypeClass` (`integer`, `float`,
`decimal`, `boolean`, `temporal`, `json`, `bytes`, `text`) moves from core into plugin-api
(`values.ts`). Core's `columnTypeClass(column)` uses the plugin's class when it is set and the
name table otherwise; the result store, the local sort and the XLSX export read it. A column
with neither a class nor a type name is still inferred from its values.

The name table gains the Oracle and SQL Server names whose meaning is the same in every
dialect: `number`, `money`, `smallmoney` → decimal; `binary_float`, `binary_double` → float;
`raw`, `image` → bytes; `datetime2`, `datetimeoffset`, `smalldatetime`, `timestamp with time
zone` → temporal; `varchar2`, `nvarchar2`, `nchar`, `nvarchar`, `ntext`, `clob`, `nclob`,
`uniqueidentifier`, `xml` → text. `bit` stays `bytes`.

## Rationale

A type name does not always say what the values are. SQL Server's `bit` is a boolean while
MySQL's `BIT(n)` is a bit string; Oracle's `NUMBER(1)` may be a flag and `NUMBER(10)` an integer
by convention. The plugin knows its server, so it says so; the name table stays for the names
that mean one thing everywhere, and for plugins that set nothing. Moving `TypeClass` to the
contract lets a plugin name a class without depending on core; the desktop protocol mirrors it
from plugin-api.

## Consequences

- The SQL Server plugin (plan 055) reports `typeClass: "boolean"` for `bit`; the Oracle plugin
  (plan 054) may report `integer` for scale-0 `NUMBER` columns.
- A wrong class from a plugin wins over the name table; the class only drives display,
  alignment, local sort and export cell types, never the value itself.
