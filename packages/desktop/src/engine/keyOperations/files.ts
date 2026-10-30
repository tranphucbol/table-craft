/** Trusted callbacks bound by the host to one authenticated engine/window owner. */
export interface EngineOperationFiles {
  read<T>(fileGrantId: string, use: (source: AsyncIterable<Uint8Array>) => Promise<T>): Promise<T>;
  publish(
    fileGrantId: string,
    operation: "cluster.snapshot" | "transfer.export" | "watch.export",
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
    signal: AbortSignal,
    onCancel?: () => Promise<void>,
  ): Promise<void>;
}
