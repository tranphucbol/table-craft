const listeners = new Set<() => void>();

/** The one way the renderer writes the clipboard, so a copy button can confirm the write it caused. */
export async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  for (const listener of listeners) listener();
}

/** Called after every successful `writeClipboard`. */
export function subscribeToCopies(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
