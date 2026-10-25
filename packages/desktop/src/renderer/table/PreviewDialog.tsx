/**
 * The statements Submit would run, in the order it runs them (plan 008 decision 15), each whole and
 * selectable so it can be copied into a console.
 */
export function PreviewStatements({
  statements,
  terminator,
}: {
  readonly statements: readonly string[];
  readonly terminator: string;
}) {
  return (
    <ol
      aria-label="Statements"
      className="flex max-h-[60vh] flex-col gap-1 overflow-auto rounded border border-line bg-canvas p-cell"
    >
      {statements.map((statement, index) => (
        <li key={index} className="flex min-w-0 gap-gap">
          <span className="shrink-0 text-ink-muted tabular-nums">{index + 1}</span>
          <code className="min-w-0 font-editor text-editor break-words whitespace-pre-wrap select-text">
            {statement}
            {terminator}
          </code>
        </li>
      ))}
    </ol>
  );
}
