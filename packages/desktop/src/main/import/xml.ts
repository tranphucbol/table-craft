/**
 * Just enough XML for the files the importers read (DataGrip's `dataSources*.xml`,
 * `recentProjects.xml`, `security.xml`, a KeePass payload): elements, attributes, text and the
 * five predefined and numeric entities. No DTDs, namespaces or external entities, so a hostile file
 * cannot make it fetch or expand anything.
 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The element's own text, entities decoded, CDATA included, children's text excluded. */
  readonly text: string;
}

export class XmlError extends Error {
  override readonly name = "XmlError";
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;
const NAME = /[^\s/>=]+/y;
const ATTRIBUTE = /\s*([^\s/>=]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

function decode(text: string): string {
  return text.replace(ENTITY, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), HEX_RADIX));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), DECIMAL_RADIX));
    return NAMED_ENTITIES[entity] ?? whole;
  });
}

interface Building {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

function skipPast(source: string, from: number, terminator: string): number {
  const end = source.indexOf(terminator, from);
  if (end < 0) throw new XmlError(`Unterminated markup: expected "${terminator}".`);
  return end + terminator.length;
}

/** Parses a whole document and returns its root element. */
export function parseXml(source: string): XmlElement {
  const stack: Building[] = [];
  let root: XmlElement | null = null;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    const top = stack.at(-1);
    const textEnd = open < 0 ? source.length : open;
    if (top !== undefined && textEnd > index) top.text += decode(source.slice(index, textEnd));
    if (open < 0) break;
    if (source.startsWith("<?", open)) {
      index = skipPast(source, open, "?>");
    } else if (source.startsWith("<!--", open)) {
      index = skipPast(source, open, "-->");
    } else if (source.startsWith("<![CDATA[", open)) {
      const end = skipPast(source, open, "]]>");
      if (top !== undefined) top.text += source.slice(open + "<![CDATA[".length, end - "]]>".length);
      index = end;
    } else if (source.startsWith("<!", open)) {
      index = skipPast(source, open, ">");
    } else if (source.startsWith("</", open)) {
      const end = skipPast(source, open, ">");
      const name = source.slice(open + 2, end - 1).trim();
      const closing = stack.pop();
      if (closing?.name !== name) throw new XmlError(`Mismatched closing tag </${name}>.`);
      const element: XmlElement = closing;
      const parent = stack.at(-1);
      if (parent === undefined) root = element;
      else parent.children.push(element);
      index = end;
    } else {
      NAME.lastIndex = open + 1;
      const name = NAME.exec(source)?.[0];
      if (name === undefined) throw new XmlError(`A tag without a name at offset ${String(open)}.`);
      let cursor = NAME.lastIndex;
      const attributes: Record<string, string> = {};
      for (;;) {
        ATTRIBUTE.lastIndex = cursor;
        const match = ATTRIBUTE.exec(source);
        if (match === null) break;
        attributes[match[1] ?? ""] = decode(match[3] ?? match[4] ?? "");
        cursor = ATTRIBUTE.lastIndex;
      }
      const close = source.indexOf(">", cursor);
      if (close < 0) throw new XmlError(`Unterminated tag <${name}>.`);
      const element: Building = { name, attributes, children: [], text: "" };
      if (source.slice(cursor, close).trim() === "/") {
        const parent = stack.at(-1);
        if (parent === undefined) root = element;
        else parent.children.push(element);
      } else {
        stack.push(element);
      }
      index = close + 1;
    }
  }
  if (stack.length > 0 || root === null) throw new XmlError("The document ends before its root element closes.");
  return root;
}

export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((candidate) => candidate.name === name);
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((candidate) => candidate.name === name);
}

/** Every descendant named `name`, in document order. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    for (const next of node.children) {
      if (next.name === name) found.push(next);
      visit(next);
    }
  };
  visit(element);
  return found;
}

export function childText(element: XmlElement, name: string): string | null {
  const found = child(element, name);
  return found === undefined ? null : found.text.trim();
}
