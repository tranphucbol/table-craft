import type { EngineMethod, RequestOf, ResultOf } from "@table-craft/desktop/engine/protocol.js";

/** Every engine method's handler, keyed by method. */
export type Routes = { [M in EngineMethod]: (request: RequestOf<M>) => Promise<ResultOf<M>> };

/** The handlers of the methods named `<P>.*`, one route group's share of `Routes`. */
export type RoutesFor<P extends string> = {
  [M in EngineMethod as M extends `${P}.${string}` ? M : never]: Routes[M];
};
