export function deferTabDrag(
  id: string,
  onDrag: (id: string) => void,
  schedule: typeof requestAnimationFrame = requestAnimationFrame,
  cancel: typeof cancelAnimationFrame = cancelAnimationFrame,
): () => void {
  let cancelled = false;
  // Covering the source during dragstart cancels Chromium's native drag before it captures its image.
  const frame = schedule(() => {
    if (!cancelled) onDrag(id);
  });
  return () => {
    cancelled = true;
    cancel(frame);
  };
}
