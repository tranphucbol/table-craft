import { describe, expect, it } from "vitest";
import { ATTACHMENTS_MAX, RECENT_FILES_MAX, createFileAttachments } from "@table-craft/desktop/main/fileAttachments.js";
import { memoryFiles } from "../support/memoryFiles.js";

const DOCUMENT = "/profile/fileAttachments.json";

describe("file attachments", () => {
  it("givenAttachedFile_whenProfileReopened_thenDatasourceAndNamespaceRemembered", async () => {
    const files = memoryFiles();
    await createFileAttachments({ path: DOCUMENT, files }).attach("/repo/seed.sql", {
      datasourceId: "pg",
      namespace: ["table_craft", "public"],
    });

    const reopened = createFileAttachments({ path: DOCUMENT, files });

    expect(await reopened.attachmentOf("/repo/seed.sql")).toEqual({
      datasourceId: "pg",
      namespace: ["table_craft", "public"],
    });
    expect(await reopened.attachmentOf("/repo/other.sql")).toBeNull();
  });

  it("givenManyFilesOpened_whenRecent_thenLastTenMostRecentFirst", async () => {
    const attachments = createFileAttachments({ path: DOCUMENT, files: memoryFiles() });
    for (let index = 0; index < RECENT_FILES_MAX + 2; index += 1) await attachments.opened(`/f${String(index)}.sql`);

    const recent = await attachments.opened("/f5.sql");

    expect(recent).toHaveLength(RECENT_FILES_MAX);
    expect(recent.slice(0, 2)).toEqual(["/f5.sql", "/f11.sql"]);
    expect(recent).not.toContain("/f0.sql");
  });

  it("givenTooManyAttachments_whenAttaching_thenOldestForgotten", async () => {
    const attachments = createFileAttachments({ path: DOCUMENT, files: memoryFiles() });
    for (let index = 0; index <= ATTACHMENTS_MAX; index += 1) {
      await attachments.attach(`/f${String(index)}.sql`, { datasourceId: "pg", namespace: null });
    }

    expect(await attachments.attachmentOf("/f0.sql")).toBeNull();
    expect(await attachments.attachmentOf(`/f${String(ATTACHMENTS_MAX)}.sql`)).not.toBeNull();
  });

  it("givenCorruptDocument_whenRead_thenStartsEmpty", async () => {
    const attachments = createFileAttachments({ path: DOCUMENT, files: memoryFiles({ [DOCUMENT]: "{not json" }) });

    expect(await attachments.recent()).toEqual([]);
    expect(await attachments.attachmentOf("/x.sql")).toBeNull();
  });
});
