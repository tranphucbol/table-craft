const listeners = new Set<() => void>();

/** The one way the renderer writes the clipboard, so a copy button can confirm the write it caused. */
export async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  copied();
}

/**
 * Confirms a write main made for this window, for text the renderer may not hold, such as a
 * client config with the MCP token in it (decision 020).
 */
export function copied(): void {
  for (const listener of listeners) listener();
}

/** Called after every successful `writeClipboard`. */
export function subscribeToCopies(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
