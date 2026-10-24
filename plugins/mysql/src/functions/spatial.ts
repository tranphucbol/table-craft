import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { MYSQL_ONLY, since } from "./ranges.js";

/** TiDB has no spatial types, so none of these exist there. */
const SINCE_8_0 = since("8.0", false);
const SINCE_8_0_12 = since("8.0.12", false);
const SINCE_8_0_24 = since("8.0.24", false);

/**
 * The common spatial functions, summarised in our own words from
 * https://dev.mysql.com/doc/refman/8.4/en/spatial-function-reference.html and
 * https://dev.mysql.com/doc/refman/5.7/en/spatial-function-reference.html.
 */
export const SPATIAL_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("spatial", [
  ["LINESTRING", "point, point... -> geometry", "A line through the points.", MYSQL_ONLY],
  ["POINT", "x, y -> geometry", "A point at the coordinates.", MYSQL_ONLY],
  ["POLYGON", "ring, ring... -> geometry", "A polygon from closed line strings.", MYSQL_ONLY],
  ["ST_AREA", "polygon -> double", "The area of a polygon or multipolygon.", MYSQL_ONLY],
  ["ST_ASBINARY", "g -> string", "The geometry in well-known binary.", MYSQL_ONLY],
  ["ST_ASGEOJSON", "g, digits?, options? -> json", "The geometry as a GeoJSON object.", MYSQL_ONLY],
  ["ST_ASTEXT", "g -> string", "The geometry in well-known text.", MYSQL_ONLY],
  ["ST_BUFFER", "g, distance, strategy... -> geometry", "Every point within a distance of the geometry.", MYSQL_ONLY],
  ["ST_CENTROID", "g -> geometry", "The geometric centre.", MYSQL_ONLY],
  ["ST_COLLECT", "g -> geometry", "Aggregates the group's geometries into a collection.", SINCE_8_0_24],
  ["ST_CONTAINS", "g1, g2 -> integer", "Whether the first geometry contains the second.", MYSQL_ONLY],
  ["ST_CONVEXHULL", "g -> geometry", "The smallest convex geometry around it.", MYSQL_ONLY],
  ["ST_CROSSES", "g1, g2 -> integer", "Whether the geometries cross.", MYSQL_ONLY],
  ["ST_DIFFERENCE", "g1, g2 -> geometry", "The part of the first geometry outside the second.", MYSQL_ONLY],
  ["ST_DIMENSION", "g -> integer", "0 for points, 1 for lines, 2 for areas.", MYSQL_ONLY],
  ["ST_DISJOINT", "g1, g2 -> integer", "Whether the geometries share no point.", MYSQL_ONLY],
  ["ST_DISTANCE", "g1, g2, unit? -> double", "The distance between two geometries.", MYSQL_ONLY],
  [
    "ST_DISTANCE_SPHERE",
    "g1, g2, radius? -> double",
    "The great-circle distance between two points, in metres.",
    MYSQL_ONLY,
  ],
  ["ST_ENDPOINT", "line -> geometry", "The last point of a line string.", MYSQL_ONLY],
  ["ST_ENVELOPE", "g -> geometry", "The bounding rectangle.", MYSQL_ONLY],
  ["ST_EQUALS", "g1, g2 -> integer", "Whether the geometries cover the same points.", MYSQL_ONLY],
  ["ST_GEOHASH", ["point, length -> string", "x, y, length -> string"], "A geohash of a point.", MYSQL_ONLY],
  ["ST_GEOMETRYTYPE", "g -> string", "The geometry's type name, such as POINT.", MYSQL_ONLY],
  ["ST_GEOMFROMGEOJSON", "json, options?, srid? -> geometry", "A geometry read from GeoJSON.", MYSQL_ONLY],
  ["ST_GEOMFROMTEXT", "wkt, srid?, options? -> geometry", "A geometry read from well-known text.", MYSQL_ONLY],
  ["ST_GEOMFROMWKB", "wkb, srid?, options? -> geometry", "A geometry read from well-known binary.", MYSQL_ONLY],
  ["ST_INTERSECTION", "g1, g2 -> geometry", "The points both geometries share.", MYSQL_ONLY],
  ["ST_INTERSECTS", "g1, g2 -> integer", "Whether the geometries share any point.", MYSQL_ONLY],
  ["ST_ISEMPTY", "g -> integer", "Whether the geometry is empty.", MYSQL_ONLY],
  ["ST_ISVALID", "g -> integer", "Whether the geometry is well formed.", MYSQL_ONLY],
  ["ST_LATITUDE", "point -> double", "The latitude of a geographic point.", SINCE_8_0_12],
  ["ST_LENGTH", "line, unit? -> double", "The length of a line string.", MYSQL_ONLY],
  ["ST_LONGITUDE", "point -> double", "The longitude of a geographic point.", SINCE_8_0_12],
  ["ST_MAKEENVELOPE", "point1, point2 -> geometry", "The rectangle two corner points span.", MYSQL_ONLY],
  ["ST_NUMPOINTS", "line -> integer", "How many points a line string has.", MYSQL_ONLY],
  ["ST_OVERLAPS", "g1, g2 -> integer", "Whether the geometries overlap.", MYSQL_ONLY],
  ["ST_POINTN", "line, n -> geometry", "The n-th point of a line string.", MYSQL_ONLY],
  ["ST_SIMPLIFY", "g, tolerance -> geometry", "The geometry with fewer points, within a tolerance.", MYSQL_ONLY],
  ["ST_SRID", "g, srid? -> integer", "The spatial reference id, or a copy with another.", MYSQL_ONLY],
  ["ST_STARTPOINT", "line -> geometry", "The first point of a line string.", MYSQL_ONLY],
  ["ST_SWAPXY", "g -> geometry", "The geometry with its coordinates swapped.", SINCE_8_0],
  ["ST_TOUCHES", "g1, g2 -> integer", "Whether the geometries touch at their edges only.", MYSQL_ONLY],
  ["ST_TRANSFORM", "g, srid -> geometry", "The geometry in another spatial reference system.", SINCE_8_0],
  ["ST_UNION", "g1, g2 -> geometry", "Every point of either geometry.", MYSQL_ONLY],
  ["ST_WITHIN", "g1, g2 -> integer", "Whether the first geometry lies inside the second.", MYSQL_ONLY],
  ["ST_X", "point, x? -> double", "The X coordinate of a point, or a copy with another.", MYSQL_ONLY],
  ["ST_Y", "point, y? -> double", "The Y coordinate of a point, or a copy with another.", MYSQL_ONLY],
]);
