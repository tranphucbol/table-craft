import * as Dialog from "@radix-ui/react-dialog";
import { ICON_BUTTON } from "@table-craft/desktop/renderer/ui/iconButtonClasses.js";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { CloseIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { FIELD_CLASS } from "@table-craft/desktop/renderer/ui/fieldClasses.js";
import { InfoHint } from "@table-craft/desktop/renderer/ui/InfoHint.js";
import { DIALOG_MOTION, OVERLAY_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";
import { FILLED_DANGER_PRESS, FILLED_PRESS, TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

export const OVERLAY_CLASS = `fixed inset-0 z-40 bg-canvas/60 ${OVERLAY_MOTION}`;
export const CONTENT_CLASS = `fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-dialog border border-line bg-panel text-ui text-ink shadow-dialog outline-none ${DIALOG_MOTION}`;
export const INPUT_CLASS = FIELD_CLASS;

type ButtonVariant = "primary" | "secondary" | "warning" | "danger" | "dangerOutline";

export const BUTTON_CLASS: Readonly<Record<ButtonVariant, string>> = {
  primary: `${FILLED_PRESS} bg-accent text-accent-ink`,
  secondary: `${TEXT_PRESS} border border-line text-ink hover:bg-hover`,
  warning: `${TEXT_PRESS} border border-warning text-warning hover:bg-hover`,
  danger: `${FILLED_DANGER_PRESS} bg-danger text-accent-ink`,
  dangerOutline: `${TEXT_PRESS} border border-danger bg-raised text-danger enabled:hover:bg-danger/10 disabled:cursor-not-allowed`,
};

/** A dialog button's classes, for a control that must render its own element (a Radix trigger). */
export function buttonClass(variant: ButtonVariant = "secondary"): string {
  return cn("h-row shrink-0 rounded px-gap", DISABLED_CLASS, BUTTON_CLASS[variant]);
}

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: ButtonVariant }) {
  return <button type="button" className={cn(buttonClass(variant), className)} {...props} />;
}

/** How every disabled control dims; fields, buttons and icon buttons alike. */
export const DISABLED_CLASS = "disabled:opacity-50";

/**
 * A big dialog's title bar: the title over a rule, with the X at its right end (plan 130 decision
 * 14). Big dialogs (`h-dialog-height`) take it; small ones put their title inline and close with
 * Escape or their footer.
 */
export function DialogHeader({ title, dialog }: { readonly title: ReactNode; readonly dialog: string }) {
  return (
    <div className="flex h-tab shrink-0 items-center gap-gap border-b border-line pr-1 pl-gap">
      <Dialog.Title className="min-w-0 flex-1 truncate font-semibold">{title}</Dialog.Title>
      <Dialog.Close aria-label={`Close ${dialog}`} title={`Close ${dialog}`} className={ICON_BUTTON}>
        <CloseIcon aria-hidden className="size-icon" />
      </Dialog.Close>
    </div>
  );
}

/**
 * A dialog's button row. `start` holds actions on the dialog's content (Test Connection…,
 * Clear…), left-aligned; `children` are the closing buttons in this order: Cancel or Close, then
 * Apply where it applies, then the primary rightmost, as macOS and the JetBrains IDEs order them.
 */
export function DialogFooter({
  start,
  className,
  children,
}: {
  readonly start?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-gap", className)}>
      {start}
      <span className="flex-1" />
      {children}
    </div>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(INPUT_CLASS, className)} spellCheck={false} {...props} />;
}

/**
 * The two columns `FieldRow`s sit in: the labels as wide as the widest of them, up to
 * `max-w-dialog-label`, so the fields line up on one edge (plan 130 decision 15).
 */
export const FIELD_GRID_CLASS = "grid grid-cols-[minmax(0,max-content)_1fr] items-center gap-x-gap gap-y-1";

/**
 * A label column and its control, in the dialog's two-column grid (`FIELD_GRID_CLASS`). A long
 * label wraps and the row grows; `hint` puts an (i) after the control, named "About" the label or
 * `hintLabel`.
 */
export function FieldRow({
  label,
  htmlFor,
  hint,
  hintLabel,
  hintTestId,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: ReactNode;
  readonly hintLabel?: string;
  readonly hintTestId?: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <label
        htmlFor={htmlFor}
        className="flex min-h-row max-w-dialog-label min-w-0 items-center leading-tight text-ink-muted"
      >
        {label}
      </label>
      <div className="flex min-h-row min-w-0 items-center gap-cell">
        {children}
        {hint === undefined || hint === null ? null : (
          <InfoHint label={hintLabel ?? `About ${label}`} {...(hintTestId === undefined ? {} : { testId: hintTestId })}>
            {hint}
          </InfoHint>
        )}
      </div>
    </>
  );
}

/** A labelled dropdown over `options`, drawn in-app (decision 140). */
export function Select({
  label,
  value,
  options,
  onChange,
  testId,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
  readonly onChange: (value: string) => void;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <Dropdown
      variant="field"
      label={label}
      testId={testId}
      className={className}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-row items-center gap-cell">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

/** A titled group of a dialog. */
export function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-cell">
      <h3 className="font-semibold text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}
