import { currentCompletions } from "@codemirror/autocomplete";
import { Prec, StateEffect, StateField, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { keymap, showTooltip, ViewPlugin, type EditorView, type Tooltip, type ViewUpdate } from "@codemirror/view";
import type {
  CompletionScope,
  EngineCalls,
  FunctionParameter,
  FunctionSignature,
  SignatureHelp,
} from "@table-craft/desktop/engine/protocol.js";
import { connectionOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

export type SignatureCall = (params: EngineCalls["completion.signature"]["params"]) => Promise<SignatureHelp | null>;

export interface SignatureTarget {
  /** The engine to ask, or null while the datasource is not connected: the hint never connects. */
  readonly signature: () => SignatureCall | null;
  readonly scope?: CompletionScope;
}

export const SIGNATURE_HINT_CLASS = "tc-signature-hint";
export const SIGNATURE_LINE_CLASS = "tc-signature-line";
export const SIGNATURE_OFF_CLASS = "tc-signature-off";
export const SIGNATURE_ACTIVE_CLASS = "tc-signature-active";
export const SIGNATURE_SUMMARY_CLASS = "tc-signature-summary";
/** Typing one of these right before the caret asks for the hint; inside a call any edit or move asks again. */
const TRIGGER_CHARACTERS = new Set(["(", ","]);
const INPUT_EVENT = "input";

const setHelp = StateEffect.define<SignatureHelp | null>();
const askHelp = StateEffect.define<null>();

const helpField = StateField.define<SignatureHelp | null>({
  create: () => null,
  update(help, transaction) {
    let next = help;
    if (next !== null && transaction.docChanged) {
      next = { ...next, from: transaction.changes.mapPos(next.from), to: transaction.changes.mapPos(next.to, 1) };
    }
    for (const effect of transaction.effects) if (effect.is(setHelp)) next = effect.value;
    return next;
  },
  provide: (field) => showTooltip.compute([field], (state) => tooltipOf(state.field(field), state)),
});

/** One piece of an overload's line; the parameter the caret is in is `active`. */
export interface HintSegment {
  readonly text: string;
  readonly active: boolean;
}

export interface HintLine {
  readonly segments: readonly HintSegment[];
  /** False when the call already has more arguments than this overload takes. */
  readonly fits: boolean;
}

const COMMA_SEPARATOR = ", ";
const LEAD_SEPARATOR = " ";

/** An optional parameter keeps its lead inside the brackets, `[RETURNING type]`, as the popup's detail does. */
function parameterLabel(parameter: FunctionParameter): string {
  const name = parameter.variadic === true ? `${parameter.name}...` : parameter.name;
  if (parameter.optional === true) return parameter.lead === undefined ? `[${name}]` : `[${parameter.lead} ${name}]`;
  return name;
}

/** What goes before a parameter: `, ` or its lead keyword; an optional one's lead sits in its brackets. */
function parameterSeparator(parameter: FunctionParameter, index: number): string {
  const lead = parameter.lead === undefined || parameter.optional === true ? "" : `${parameter.lead}${LEAD_SEPARATOR}`;
  if (index === 0) return lead;
  return parameter.lead === undefined ? COMMA_SEPARATOR : `${LEAD_SEPARATOR}${lead}`;
}

/** The parameter the `argument`-th argument fills, a variadic last one taking every argument after it; -1 for none. */
export function activeParameter(signature: FunctionSignature, argument: number): number {
  const count = signature.parameters.length;
  if (argument < count) return argument;
  return signature.parameters.at(-1)?.variadic === true ? count - 1 : -1;
}

/** Every overload as `name(a, b) → type` or `name(unit FROM date) → type`, the parameter the caret is in marked active. */
export function hintLines(help: SignatureHelp): readonly HintLine[] {
  return help.signatures.map((signature) => {
    const active = activeParameter(signature, help.argument);
    const segments: HintSegment[] = [{ text: `${help.name}(`, active: false }];
    signature.parameters.forEach((parameter, index) => {
      const separator = parameterSeparator(parameter, index);
      if (separator !== "") segments.push({ text: separator, active: false });
      segments.push({ text: parameterLabel(parameter), active: index === active });
    });
    segments.push({ text: signature.returns === "" ? ")" : `) → ${signature.returns}`, active: false });
    return { segments, fits: active >= 0 || (help.argument === 0 && signature.parameters.length === 0) };
  });
}

function hintDom(help: SignatureHelp): HTMLElement {
  const dom = document.createElement("div");
  dom.className = SIGNATURE_HINT_CLASS;
  for (const line of hintLines(help)) {
    const row = document.createElement("div");
    row.className = line.fits ? SIGNATURE_LINE_CLASS : `${SIGNATURE_LINE_CLASS} ${SIGNATURE_OFF_CLASS}`;
    for (const segment of line.segments) {
      if (!segment.active) {
        row.append(segment.text);
        continue;
      }
      const span = document.createElement("span");
      span.className = SIGNATURE_ACTIVE_CLASS;
      span.textContent = segment.text;
      row.append(span);
    }
    dom.append(row);
  }
  const summary = document.createElement("div");
  summary.className = SIGNATURE_SUMMARY_CLASS;
  summary.textContent = help.summary;
  dom.append(summary);
  return dom;
}

function tooltipOf(help: SignatureHelp | null, state: EditorState): Tooltip | null {
  if (help === null) return null;
  return { pos: Math.min(help.from, state.doc.length), above: true, create: () => ({ dom: hintDom(help) }) };
}

/** Whether typing in `transactions` left `(` or `,` right before the caret, as opening or continuing a call does. */
export function typedTrigger(state: EditorState, transactions: readonly Transaction[]): boolean {
  if (!transactions.some((transaction) => transaction.docChanged && transaction.isUserEvent(INPUT_EVENT))) {
    return false;
  }
  const head = state.selection.main.head;
  return head > 0 && TRIGGER_CHARACTERS.has(state.sliceDoc(head - 1, head));
}

function closeHint(view: EditorView): boolean {
  const help = view.state.field(helpField, false);
  if (help === undefined || help === null) return false;
  view.dispatch({ effects: setHelp.of(null) });
  return true;
}

/** Shows the hint for the call at the caret now, as Parameter Info (⌘P) does. */
export function requestParameterInfo(view: EditorView): void {
  if (view.state.field(helpField, false) === undefined) return;
  view.dispatch({ effects: askHelp.of(null) });
}

/**
 * Asks the engine for the call around the caret when `(` or `,` is typed, on Parameter Info, and
 * on every edit or move while the hint shows, so it follows the caret and closes once it leaves
 * the call; a response a newer request or a close has overtaken is dropped.
 */
function hintPlugin(target: SignatureTarget) {
  return ViewPlugin.fromClass(
    class {
      latest = 0;
      /** A request is out for a hint not shown yet; typing past `(` before it answers must ask again. */
      awaiting = false;

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (update.focusChanged && !update.view.hasFocus) {
          this.drop();
          if (update.state.field(helpField) !== null) queueMicrotask(() => closeHint(this.view));
          return;
        }
        const explicit = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(askHelp)),
        );
        const open = update.state.field(helpField) !== null;
        // A request still in flight when the hint closes (Escape, leaving the call) would reopen it.
        if (!open && !explicit && update.startState.field(helpField) !== null) {
          this.drop();
          return;
        }
        const moved = update.docChanged || update.selectionSet;
        if (explicit || typedTrigger(update.state, update.transactions) || ((open || this.awaiting) && moved)) {
          this.ask();
        }
      }

      drop(): void {
        this.latest += 1;
        this.awaiting = false;
      }

      ask(): void {
        this.latest += 1;
        const request = this.latest;
        const call = target.signature();
        if (call === null) {
          this.awaiting = false;
          queueMicrotask(() => closeHint(this.view));
          return;
        }
        this.awaiting = true;
        const state = this.view.state;
        const params = {
          text: state.doc.toString(),
          offset: state.selection.main.head,
          ...(target.scope === undefined ? {} : { scope: target.scope }),
        };
        const answer = (help: SignatureHelp | null) => {
          if (request !== this.latest || !this.view.dom.isConnected) return;
          this.awaiting = false;
          if (help === null) closeHint(this.view);
          else this.view.dispatch({ effects: setHelp.of(help) });
        };
        call(params).then(answer, () => answer(null));
      }

      destroy(): void {
        this.drop();
      }
    },
  );
}

/**
 * Escape closes a shown completion popup first, then the hint. The hint goes ahead of
 * autocompletion's own Escape, which also swallows the key while a source is merely active and
 * no option is shown.
 */
function escapeHint(view: EditorView): boolean {
  return currentCompletions(view.state).length === 0 && closeHint(view);
}

/** The parameter hint: the call's overloads above it, the parameter at the caret bold; Escape hides it. */
export function signatureHint(target: SignatureTarget): Extension {
  return [helpField, hintPlugin(target), Prec.highest(keymap.of([{ key: "Escape", run: escapeHint }]))];
}

/** The datasource's engine while it is connected; null otherwise. */
export function connectedSignature(datasourceId: () => string | undefined): () => SignatureCall | null {
  return () => {
    const id = datasourceId();
    if (id === undefined) return null;
    const datasources = useDatasources.getState();
    if (connectionOf(datasources, id).status !== "connected") return null;
    return async (params) => (await datasources.connect(id)).call("completion.signature", params);
  };
}
