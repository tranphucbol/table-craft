import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { DIALOG_MOTION, OVERLAY_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";
import { FILLED_DANGER_PRESS, FILLED_PRESS, TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

export const OVERLAY_CLASS = `fixed inset-0 z-40 bg-canvas/60 ${OVERLAY_MOTION}`;
export const CONTENT_CLASS = `fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel text-ui text-ink shadow-2xl outline-none ${DIALOG_MOTION}`;
export const INPUT_CLASS =
  "h-row min-w-0 rounded border border-line bg-canvas px-cell text-ink outline-none focus:border-accent disabled:opacity-60 aria-invalid:border-danger";

type ButtonVariant = "primary" | "secondary" | "danger" | "dangerOutline";

export const BUTTON_CLASS: Readonly<Record<ButtonVariant, string>> = {
  primary: `${FILLED_PRESS} bg-accent text-accent-ink`,
  secondary: `${TEXT_PRESS} border border-line text-ink hover:bg-raised`,
  danger: `${FILLED_DANGER_PRESS} bg-danger text-accent-ink`,
  dangerOutline: `${TEXT_PRESS} border border-danger bg-raised text-danger enabled:hover:bg-danger/10 disabled:cursor-not-allowed`,
};

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={cn(
        "h-row shrink-0 rounded px-gap",
        variant === "dangerOutline" ? "disabled:opacity-40" : "disabled:opacity-50",
        BUTTON_CLASS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(INPUT_CLASS, className)} spellCheck={false} {...props} />;
}

/** A label column and its control, in the dialog's two-column grid. */
export function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <>
      <label htmlFor={htmlFor} className="flex h-row items-center justify-end text-ink-muted">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-cell">{children}</div>
    </>
  );
}

/** A labelled native select over `options`. */
export function Select({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
  readonly onChange: (value: string) => void;
  readonly testId?: string;
}) {
  return (
    <select
      aria-label={label}
      data-testid={testId}
      className={INPUT_CLASS}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
