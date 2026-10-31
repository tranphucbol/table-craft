import { siEtcd, siMariadb, siMongodb, siMysql, siPostgresql, siRedis, siSqlite, siTidb } from "simple-icons";
import { brandInk } from "@table-craft/desktop/appearance/brandInk.js";
import type { Brand, DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { datasourceBrand } from "@table-craft/desktop/renderer/model/brand.js";
import { connectionOf, pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { themeOf, useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { DatabaseIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ORACLE_GLYPH, SQL_SERVER_GLYPH } from "@table-craft/desktop/renderer/ui/retiredBrandGlyphs.js";

/** Every simple-icons path is drawn on this square. */
const SIMPLE_ICONS_VIEW_BOX = "0 0 24 24";

export interface BrandGlyph {
  readonly path: string;
  /** The brand's colour as simple-icons gives it, `rrggbb` without the `#`. */
  readonly hex: string;
}

/**
 * The logos the app bundles, by simple-icons slug (decision 128). Named imports only, so the
 * bundler keeps these and drops the rest; a brand missing here draws the generic glyph.
 */
export const BRAND_GLYPHS: Readonly<Record<string, BrandGlyph>> = {
  [siMysql.slug]: siMysql,
  [siMariadb.slug]: siMariadb,
  [siTidb.slug]: siTidb,
  [siPostgresql.slug]: siPostgresql,
  [siRedis.slug]: siRedis,
  [siSqlite.slug]: siSqlite,
  [siMongodb.slug]: siMongodb,
  [siEtcd.slug]: siEtcd,
  [ORACLE_GLYPH.slug]: ORACLE_GLYPH,
  [SQL_SERVER_GLYPH.slug]: SQL_SERVER_GLYPH,
};

function brandGlyph(brand: Brand | null): BrandGlyph | undefined {
  return brand === null ? undefined : BRAND_GLYPHS[brand.id];
}

/** What `data-glyph` holds on a datasource icon drawn without a logo, for tests to tell them apart. */
export const GENERIC_GLYPH = "generic";

/** A logo in one colour, `currentColor`, which its caller sets by class or style. */
export function BrandIcon({
  path,
  glyph,
  className,
  color,
}: {
  readonly path: string;
  readonly glyph?: string | undefined;
  readonly className?: string | undefined;
  readonly color?: string | undefined;
}) {
  return (
    <svg
      aria-hidden
      data-glyph={glyph}
      viewBox={SIMPLE_ICONS_VIEW_BOX}
      fill="currentColor"
      className={className}
      style={color === undefined ? undefined : { color }}
    >
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

/** Whether logos take their brand's colour or the theme's gray (Settings › Appearance › Data sources). */
function useGrayLogos(): boolean {
  return useSettings((state) => state.settings.appearance.brandIconColor === "gray");
}

/** Whether `brand` draws its logo: brand icons are on and the app bundles one for it. */
export function useBrandLogo(brand: Brand | null): boolean {
  const on = useBrandIcons();
  return on && brandGlyph(brand) !== undefined;
}

/** The brand's own colour, fitted to the current theme's surfaces (`brandInk`). */
function useBrandInk(hex: string): string {
  return useSettings((state) => brandInk(`#${hex}`, themeOf(state).theme.colors));
}

/** A datasource icon's state colour, which outranks the brand's: a failed connect, a missing plugin. */
export type GlyphTone = "danger" | "muted";

const TONE_CLASS: Readonly<Record<GlyphTone, string>> = { danger: "text-danger", muted: "text-ink-muted" };

const GRAY_LOGO_CLASS = "text-ink-muted";

function BrandLogo({
  brand,
  glyph,
  className,
}: {
  readonly brand: Brand;
  readonly glyph: BrandGlyph;
  readonly className?: string | undefined;
}) {
  const color = useBrandInk(glyph.hex);
  return <BrandIcon path={glyph.path} glyph={brand.id} className={className} color={color} />;
}

/**
 * A datasource's icon: its product's logo, in the brand's colour or gray as chosen, when brand icons
 * are on and one is bundled, else the generic glyph in the accent. A `tone` paints either in its
 * state colour.
 */
export function DatasourceGlyph({
  brand,
  tone,
  className,
}: {
  readonly brand: Brand | null;
  readonly tone?: GlyphTone | null | undefined;
  readonly className?: string | undefined;
}) {
  const on = useBrandIcons();
  const gray = useGrayLogos();
  const glyph = on ? brandGlyph(brand) : undefined;
  const toneClass = tone == null ? undefined : TONE_CLASS[tone];
  if (glyph === undefined || brand === null) {
    return (
      <DatabaseIcon aria-hidden data-glyph={GENERIC_GLYPH} className={cn(className, toneClass ?? "text-accent")} />
    );
  }
  if (toneClass !== undefined || gray) {
    return <BrandIcon path={glyph.path} glyph={brand.id} className={cn(className, toneClass ?? GRAY_LOGO_CLASS)} />;
  }
  return <BrandLogo brand={brand} glyph={glyph} className={className} />;
}
