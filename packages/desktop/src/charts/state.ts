/** A result's chart on its way to the save dialog as a PNG: main writes the bytes where the user chooses (plan 155). */
export interface ChartImageRequest {
  readonly data: Uint8Array;
  readonly defaultName: string;
}
