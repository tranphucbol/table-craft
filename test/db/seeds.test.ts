import { describe, expect, it } from "vitest";
import { DATABASE_IDS, databaseEnabled } from "../support/databases.js";
import { sentinelsFor, serverQuery, servicesOf } from "../support/smokeFixtures.js";

/** Every selected server answers with its seed's sentinels; SQL Server holds only those until 055. */
describe.each(DATABASE_IDS.filter((id) => servicesOf([id]).length > 0))("%s seed", (id) => {
  for (const sentinel of sentinelsFor(servicesOf([id]))) {
    it.skipIf(!databaseEnabled(id))(
      `givenSelected_whenAsked_then${sentinel.service}Holds ${sentinel.object}`,
      async () => {
        expect(await serverQuery(sentinel.service, sentinel.sql)).toBe(true);
      },
    );
  }
});
