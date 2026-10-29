import { siMariadb, siMongodb, siMysql, siPostgresql, siRedis, siSqlite, siTidb } from "simple-icons";
import type { Brand, DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { datasourceBrand } from "@table-craft/desktop/renderer/model/brand.js";
import { connectionOf, pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { DatabaseIcon } from "@table-craft/desktop/renderer/ui/icons.js";

/** Every simple-icons path is drawn on this square. */
const SIMPLE_ICONS_VIEW_BOX = "0 0 24 24";

/**
 * The logos the app bundles, by simple-icons slug (decision 128). Named imports only, so the
 * bundler keeps these and drops the rest; a brand missing here draws the generic glyph.
 */
const BRAND_GLYPHS: Readonly<Record<string, { readonly path: string }>> = {
  [siMysql.slug]: siMysql,
  [siMariadb.slug]: siMariadb,
  [siTidb.slug]: siTidb,
  [siPostgresql.slug]: siPostgresql,
  [siRedis.slug]: siRedis,
  [siSqlite.slug]: siSqlite,
  [siMongodb.slug]: siMongodb,
};

function brandGlyph(brand: Brand | null): { readonly path: string } | undefined {
  return brand === null ? undefined : BRAND_GLYPHS[brand.id];
}

/** What `data-glyph` holds on a datasource icon drawn without a logo, for tests to tell them apart. */
export const GENERIC_GLYPH = "generic";

/** A logo in one colour, `currentColor`, so it takes the classes the generic glyph would. */
export function BrandIcon({
  path,
  glyph,
  className,
}: {
  readonly path: string;
  readonly glyph?: string | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <svg aria-hidden data-glyph={glyph} viewBox={SIMPLE_ICONS_VIEW_BOX} fill="currentColor" className={className}>
      <path d={path} />
    </svg>
  );
}

/** The product `datasource` is, by its live connection, what it remembers and its plugin's brands. */
export function useDatasourceBrand(datasource: Pick<DatasourceView, "id" | "pluginId" | "brand">): Brand | null {
  return useDatasources((state) =>
    datasourceBrand({
      connectionBrand: connectionOf(state, datasource.id).serverBrand,
      storedBrand: datasource.brand,
      brands: pluginOf(state.plugins, datasource.pluginId)?.brands,
    }),
  );
}

/** Whether Settings › Appearance draws logos on data sources. */
export function useBrandIcons(): boolean {
  return useSettings((state) => state.settings.appearance.brandIcons);
}

/** Whether `brand` draws its logo: brand icons are on and the app bundles one for it. */
export function useBrandLogo(brand: Brand | null): boolean {
  const on = useBrandIcons();
  return on && brandGlyph(brand) !== undefined;
}

/** A datasource's icon: its product's logo when brand icons are on and one is bundled, else the generic glyph. */
export function DatasourceGlyph({
  brand,
  className,
}: {
  readonly brand: Brand | null;
  readonly className?: string | undefined;
}) {
  const on = useBrandIcons();
  const glyph = on ? brandGlyph(brand) : undefined;
  if (glyph === undefined || brand === null) {
    return <DatabaseIcon aria-hidden data-glyph={GENERIC_GLYPH} className={className} />;
  }
  return <BrandIcon path={glyph.path} glyph={brand.id} className={className} />;
}
