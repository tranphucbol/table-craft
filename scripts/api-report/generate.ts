/**
 * Builds the public surface reports of `@table-craft/plugin-api` (decision 107): one per entry,
 * from declarations the repository's TypeScript emits in memory, so the report is what a plugin
 * compiled against the package sees.
 */
import { join, posix } from "node:path";
import ts from "typescript";
import {
  addMember,
  BLOCK_CLOSE,
  BLOCK_OPEN,
  DEPRECATED_MARK,
  ENTRY_PREFIX,
  FENCE_CLOSE,
  FENCE_OPEN,
  MEMBER_INDENT,
  UNEXPORTED_MARK,
  VERSION_PREFIX,
  type SurfaceMember,
  type SurfaceModel,
  type SurfaceSymbol,
} from "./model.js";

export const PACKAGE_DIRECTORY = "packages/plugin-api";
export const REPORT_DIRECTORY = `${PACKAGE_DIRECTORY}/api`;
const SOURCE_DIRECTORY = `${PACKAGE_DIRECTORY}/src`;
const PACKAGE_NAME = "@table-craft/plugin-api";
const VIRTUAL_OUT = "/__api_report__";
const DECLARATION_EXTENSION = ".d.ts";
const TSCONFIG = "tsconfig.json";

export interface ReportEntry {
  /** The import specifier a plugin writes. */
  specifier: string;
  /** Relative to the package's `src/`. */
  source: string;
  /** Relative to the repository root. */
  report: string;
}

export const REPORT_ENTRIES: readonly ReportEntry[] = [
  { specifier: PACKAGE_NAME, source: "index.ts", report: `${REPORT_DIRECTORY}/plugin-api.api.md` },
  { specifier: `${PACKAGE_NAME}/sql`, source: "sql/index.ts", report: `${REPORT_DIRECTORY}/plugin-api-sql.api.md` },
  {
    specifier: `${PACKAGE_NAME}/testing`,
    source: "testing/index.ts",
    report: `${REPORT_DIRECTORY}/plugin-api-testing.api.md`,
  },
];

export interface ApiReport {
  entry: ReportEntry;
  text: string;
}

export class ApiReportError extends Error {
  override name = "ApiReportError";
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

interface Module {
  path: string;
  source: ts.SourceFile;
  locals: Map<string, ts.Statement[]>;
}

interface Target {
  module: Module;
  name: string;
}

function emitDeclarations(root: string): Map<string, string> {
  const configPath = join(root, TSCONFIG);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new ApiReportError(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (parsed === undefined) throw new ApiReportError(`Cannot read ${configPath}.`);
  const sourceRoot = join(root, SOURCE_DIRECTORY);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    removeComments: false,
    rootDir: sourceRoot,
    outDir: VIRTUAL_OUT,
  };
  const rootNames = REPORT_ENTRIES.map((entry) => join(sourceRoot, entry.source));
  const program = ts.createProgram({ rootNames, options });
  const files = new Map<string, string>();
  const emitted = program.emit(undefined, (fileName, text) => {
    files.set(posix.relative(VIRTUAL_OUT, fileName.replaceAll("\\", "/")), text);
  });
  const problems = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (problems.length > 0) {
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    };
    throw new ApiReportError(`plugin-api does not compile:\n${ts.formatDiagnostics(problems, host)}`);
  }
  return files;
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    (ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name !== undefined &&
    ts.isIdentifier(statement.name)
  ) {
    return [statement.name.text];
  }
  return [];
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function specifierText(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;
}

class DeclarationGraph {
  private readonly modules = new Map<string, Module>();

  constructor(files: Map<string, string>) {
    for (const [path, text] of files) {
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const locals = new Map<string, ts.Statement[]>();
      for (const statement of source.statements) {
        for (const name of declaredNames(statement)) locals.set(name, [...(locals.get(name) ?? []), statement]);
      }
      this.modules.set(path, { path, source, locals });
    }
  }

  module(path: string): Module {
    const module = this.modules.get(path);
    if (module === undefined) throw new ApiReportError(`No declarations were emitted for ${path}.`);
    return module;
  }

  /** The emitted module a specifier names, or undefined for a package outside plugin-api. */
  private moduleAt(from: Module, specifier: string): Module | undefined {
    let path: string | undefined;
    if (specifier.startsWith(".")) {
      path = posix.join(posix.dirname(from.path), specifier.replace(/\.js$/, DECLARATION_EXTENSION));
    } else {
      const entry = REPORT_ENTRIES.find((candidate) => candidate.specifier === specifier);
      if (entry !== undefined) path = entry.source.replace(/\.ts$/, DECLARATION_EXTENSION);
    }
    if (path === undefined) return undefined;
    return this.modules.get(path) ?? this.modules.get(path.replace(/\.d\.ts$/, `/index${DECLARATION_EXTENSION}`));
  }

  /** Where `name`, as seen in `module`, is declared; undefined for a global or an outside package. */
  resolve(module: Module, name: string, seen = new Set<string>()): Target | undefined {
    const visit = `${module.path}#${name}`;
    if (seen.has(visit)) return undefined;
    seen.add(visit);
    if (module.locals.has(name)) return { module, name };
    for (const statement of module.source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
        const element = bindings.elements.find((candidate) => candidate.name.text === name);
        if (element === undefined) continue;
        const target = this.moduleAt(module, specifierText(statement.moduleSpecifier) ?? "");
        return target && this.resolve(target, element.propertyName?.text ?? name, seen);
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
        if (!ts.isNamedExports(statement.exportClause)) continue;
        const element = statement.exportClause.elements.find((candidate) => candidate.name.text === name);
        if (element === undefined) continue;
        const local = element.propertyName?.text ?? name;
        const specifier = specifierText(statement.moduleSpecifier);
        if (specifier === undefined) return this.resolve(module, local, seen);
        const target = this.moduleAt(module, specifier);
        return target && this.resolve(target, local, seen);
      }
    }
    return undefined;
  }

  /** Every name the module exports, with its declaration or, for an outside package, its specifier. */
  exports(module: Module): Map<string, Target | string> {
    const result = new Map<string, Target | string>();
    for (const statement of module.source.statements) {
      if (hasExportModifier(statement)) {
        for (const name of declaredNames(statement)) result.set(name, { module, name });
        continue;
      }
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier = specifierText(statement.moduleSpecifier);
      const target = specifier === undefined ? module : this.moduleAt(module, specifier);
      if (statement.exportClause === undefined) {
        if (target === undefined) throw new ApiReportError(`export * from "${specifier}" is not reportable.`);
        for (const [name, value] of this.exports(target)) result.set(name, value);
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) {
        throw new ApiReportError(`Namespace re-exports are not reportable (${module.path}).`);
      }
      for (const element of statement.exportClause.elements) {
        const name = element.name.text;
        const local = element.propertyName?.text ?? name;
        if (target === undefined) {
          result.set(name, `export { ${name} } from "${specifier}";`);
          continue;
        }
        const resolved = this.resolve(target, local);
        if (resolved === undefined) throw new ApiReportError(`Cannot find "${local}" exported by ${module.path}.`);
        result.set(name, resolved);
      }
    }
    return result;
  }

  /** The declarations a statement names in its types, resolved where plugin-api declares them. */
  references(target: Target): Target[] {
    const found: Target[] = [];
    const visit = (node: ts.Node): void => {
      let name: string | undefined;
      if (ts.isTypeReferenceNode(node)) name = leftmost(node.typeName);
      else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) name = node.expression.text;
      else if (ts.isTypeQueryNode(node)) name = leftmost(node.exprName);
      if (name !== undefined) {
        const resolved = this.resolve(target.module, name);
        if (resolved !== undefined) found.push(resolved);
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of target.module.locals.get(target.name) ?? []) visit(statement);
    return found;
  }
}

function leftmost(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmost(name.left);
}

function identity(target: Target): string {
  return `${target.module.path}#${target.name}`;
}

function oneLine(node: ts.Node, source: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, " ").trim();
}

function isDeprecated(node: ts.Node): boolean {
  return ts.getJSDocDeprecatedTag(node) !== undefined;
}

function terminated(text: string): string {
  return text.endsWith(";") ? text : `${text};`;
}

function typeParameters(
  parameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  source: ts.SourceFile,
): string {
  if (parameters === undefined || parameters.length === 0) return "";
  return `<${parameters.map((parameter) => oneLine(parameter, source)).join(", ")}>`;
}

function heritage(clauses: ts.NodeArray<ts.HeritageClause> | undefined, source: ts.SourceFile): string {
  if (clauses === undefined || clauses.length === 0) return "";
  return ` ${clauses.map((clause) => oneLine(clause, source)).join(" ")}`;
}

function memberMap(members: readonly ts.Node[], source: ts.SourceFile): Map<string, SurfaceMember> {
  const map = new Map<string, SurfaceMember>();
  for (const member of members) {
    if (ts.isClassElement(member) && member.name !== undefined && ts.isPrivateIdentifier(member.name)) continue;
    const text = ts.isEnumMember(member) ? `${oneLine(member, source)},` : terminated(oneLine(member, source));
    addMember(map, text, isDeprecated(member));
  }
  return map;
}

function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function describeSymbol(name: string, target: Target, exported: boolean): SurfaceSymbol {
  const statements = target.module.locals.get(target.name) ?? [];
  const source = target.module.source;
  const deprecated = statements.length > 0 && statements.every(isDeprecated);
  const [first] = statements;
  if (first === undefined) throw new ApiReportError(`"${target.name}" has no declaration in ${target.module.path}.`);
  const symbol = (header: string, members: Map<string, SurfaceMember> | null): SurfaceSymbol => ({
    name,
    exported,
    deprecated,
    header,
    members,
  });

  if (ts.isInterfaceDeclaration(first)) {
    const interfaces = statements.filter(ts.isInterfaceDeclaration);
    const header = `interface ${name}${typeParameters(first.typeParameters, source)}${heritage(first.heritageClauses, source)}`;
    return symbol(
      header,
      memberMap(
        interfaces.flatMap((declaration) => [...declaration.members]),
        source,
      ),
    );
  }
  if (ts.isTypeAliasDeclaration(first) && ts.isTypeLiteralNode(first.type)) {
    return symbol(
      `type ${name}${typeParameters(first.typeParameters, source)} =`,
      memberMap(first.type.members, source),
    );
  }
  if (ts.isClassDeclaration(first)) {
    const abstract = hasModifier(first, ts.SyntaxKind.AbstractKeyword) ? "abstract " : "";
    const header = `${abstract}class ${name}${typeParameters(first.typeParameters, source)}${heritage(first.heritageClauses, source)}`;
    return symbol(header, memberMap(first.members, source));
  }
  if (ts.isEnumDeclaration(first)) {
    const constant = hasModifier(first, ts.SyntaxKind.ConstKeyword) ? "const " : "";
    return symbol(`${constant}enum ${name}`, memberMap(first.members, source));
  }
  if (ts.isVariableStatement(first)) {
    const declaration = first.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === target.name,
    );
    if (declaration === undefined) throw new ApiReportError(`Cannot find the declaration of "${target.name}".`);
    const keyword = first.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
    const type = declaration.type === undefined ? "" : `: ${oneLine(declaration.type, source)}`;
    const value = declaration.initializer === undefined ? "" : ` = ${oneLine(declaration.initializer, source)}`;
    return symbol(`${keyword} ${name}${type}${value};`, null);
  }
  const text = statements
    .map((statement) =>
      oneLine(statement, source)
        .replace(/^(?:export )?(?:declare )?/, "")
        .replace(new RegExp(`^(type|function|namespace) ${target.name}\\b`), `$1 ${name}`),
    )
    .join(" ");
  return symbol(terminated(text), null);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderSymbol(symbol: SurfaceSymbol): string[] {
  const prefix = `${symbol.deprecated ? DEPRECATED_MARK : ""}${symbol.exported ? "" : UNEXPORTED_MARK}`;
  if (symbol.members === null) return [`${prefix}${symbol.header}`];
  const members = [...symbol.members.values()]
    .sort((left, right) => compareNames(left.key, right.key))
    .flatMap((member) =>
      member.texts.map((text) => `${MEMBER_INDENT}${member.deprecated ? DEPRECATED_MARK : ""}${text}`),
    );
  return [`${prefix}${symbol.header}${BLOCK_OPEN}`, ...members, BLOCK_CLOSE];
}

/** The report text for a model; `parseReport` reads it back to the same model. */
export function renderReport(model: SurfaceModel): string {
  const symbols = [...model.symbols.values()].sort(
    (left, right) => Number(!left.exported) - Number(!right.exported) || compareNames(left.name, right.name),
  );
  const body = symbols.map((symbol) => renderSymbol(symbol).join("\n")).join("\n\n");
  return [
    `${ENTRY_PREFIX}${model.entry}\``,
    "",
    "Generated by `bun run api:report`; do not edit. `bun run api:check` compares it with the report at",
    "the last release tag (decision 107). `~Name` is a type no entry exports that an export reaches.",
    "",
    `${VERSION_PREFIX}${model.apiVersion}`,
    "",
    FENCE_OPEN,
    body,
    FENCE_CLOSE,
    "",
  ].join("\n");
}

/** The surface of every entry, as declared by the source under `root`. */
export function generateModels(root: string, apiVersion: string): SurfaceModel[] {
  const graph = new DeclarationGraph(emitDeclarations(root));
  const entryModules = REPORT_ENTRIES.map((entry) =>
    graph.module(entry.source.replace(/\.ts$/, DECLARATION_EXTENSION)),
  );
  const exported = new Set<string>();
  const entryExports = entryModules.map((module) => graph.exports(module));
  for (const exports of entryExports) {
    for (const value of exports.values()) if (typeof value !== "string") exported.add(identity(value));
  }

  return REPORT_ENTRIES.map((entry, index) => {
    const symbols = new Map<string, SurfaceSymbol>();
    const reached = new Map<string, Target>();
    const pending: Target[] = [];
    for (const [name, value] of entryExports[index] ?? []) {
      if (typeof value === "string") {
        symbols.set(name, { name, exported: true, deprecated: false, header: value, members: null });
        continue;
      }
      symbols.set(name, describeSymbol(name, value, true));
      pending.push(value);
    }
    for (let target = pending.pop(); target !== undefined; target = pending.pop()) {
      for (const reference of graph.references(target)) {
        const key = identity(reference);
        if (exported.has(key) || reached.has(key)) continue;
        if (symbols.has(reference.name)) {
          throw new ApiReportError(`Two declarations named "${reference.name}" reach ${entry.specifier}; rename one.`);
        }
        reached.set(key, reference);
        symbols.set(reference.name, describeSymbol(reference.name, reference, false));
        pending.push(reference);
      }
    }
    return { entry: entry.specifier, apiVersion, symbols };
  });
}

export function generateReports(root: string, apiVersion: string): ApiReport[] {
  return generateModels(root, apiVersion).map((model, index) => {
    const entry = REPORT_ENTRIES[index];
    if (entry === undefined) throw new ApiReportError("Entries and models are out of step.");
    return { entry, text: renderReport(model) };
  });
}
