import type { Brand } from "@table-craft/desktop/preload/bridge.js";

export interface BrandSources {
  /** What the server said on the last successful connect this run; null before one. */
  readonly connectionBrand: string | null;
  /** What the datasource remembers: picked in New Data Source, or reported by an earlier connect. */
  readonly storedBrand: string | undefined;
  /** The plugin's brands, the default first; undefined when the plugin is not installed. */
  readonly brands: readonly Brand[] | undefined;
}

/**
 * The product a datasource is: the live server's word, else the remembered one, else the plugin's
 * default. Only a brand the plugin declares counts, so a stale id falls back rather than drawing a
 * logo the plugin no longer claims.
 */
export function datasourceBrand({ connectionBrand, storedBrand, brands }: BrandSources): Brand | null {
  if (brands === undefined || brands.length === 0) return null;
  const declared = (id: string | null | undefined) =>
    id === null || id === undefined ? undefined : brands.find((brand) => brand.id === id);
  return declared(connectionBrand) ?? declared(storedBrand) ?? brands[0] ?? null;
}
