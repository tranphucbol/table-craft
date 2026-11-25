# 177: Discovered databases are selected, session-only siblings

Status: Accepted

## Decision

A plugin that can enumerate connectable databases declares the `databases` capability and provides a
required `session.services.databases` service. The service returns names for a picker; it does not
create saved data sources. A user-selected database appears as a session-only sibling under its
source connection, with a stable id derived from the source id and database name. The sibling uses
the source's connection settings and credentials. Database selection is stored separately from
schema visibility, and newly discovered databases stay hidden until selected.

## Rationale

Many SQL servers host several databases behind one endpoint. PostgreSQL cannot switch databases
inside a session, so the engine needs a separate connection for each selected database. Registering
every database as a normal data source would pollute the connection switcher, diagnostics and agent
supervisor, create empty folders, and open many backend connections when users expand the tree. A
picker plus selected siblings keeps one saved connection while allowing each selected database its
own engine session.

## Consequences

The datasource list returns saved connections, selected database siblings and picker names in
separate fields. The renderer uses explicit `databaseSource` metadata instead of reading plugin
configuration keys. Removing a database from the server or changing its source settings stops the
sibling engine and removes its saved console and history files. Plugins without the capability do
not connect when the picker opens.
