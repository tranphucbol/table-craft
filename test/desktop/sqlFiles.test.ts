import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileAttachments } from "@table-craft/desktop/main/fileAttachments.js";
import {
  SqlFileError,
  createSqlFileChannels,
  readSqlFile,
  renameSqlFile,
  statSqlFiles,
  writeSqlFile,
} from "@table-craft/desktop/main/sqlFiles.js";
import { memoryFiles } from "../support/memoryFiles.js";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "tc-sql-files-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function fileWith(name: string, content: string | Buffer): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, content);
  return path;
}

describe("sql files", () => {
  it("givenFileConsole_whenSave_thenFileOnDiskMatches", async () => {
    const path = await fileWith("seed.sql", "SELECT 1;\n");
    const opened = await readSqlFile(path);

    const { modifiedAt } = await writeSqlFile(path, `${opened.sql}SELECT 2;\n`, opened.lineEnding);

    expect(await readFile(path, "utf8")).toBe("SELECT 1;\nSELECT 2;\n");
    expect(modifiedAt).toBe((await stat(path)).mtimeMs);
  });

  it("givenCrlfFile_whenSaved_thenKeepsCrlf", async () => {
    const path = await fileWith("crlf.sql", "SELECT 1;\r\nSELECT 2;\r\n");

    const opened = await readSqlFile(path);
    await writeSqlFile(path, `${opened.sql}SELECT 3;\n`, opened.lineEnding);

    expect(opened).toMatchObject({ sql: "SELECT 1;\nSELECT 2;\n", lineEnding: "crlf" });
    expect(await readFile(path, "utf8")).toBe("SELECT 1;\r\nSELECT 2;\r\nSELECT 3;\r\n");
  });

  it("givenBomFile_whenOpen_thenBomStripped", async () => {
    const path = await fileWith("bom.sql", Buffer.concat([BOM, Buffer.from("SELECT 1;")]));

    const opened = await readSqlFile(path);
    await writeSqlFile(path, opened.sql, opened.lineEnding);

    expect(opened.sql).toBe("SELECT 1;");
    expect(await readFile(path)).toEqual(Buffer.from("SELECT 1;"));
  });

  it("givenLatin1File_whenOpen_thenRefusedNamingByteOffset", async () => {
    const path = await fileWith("latin1.sql", Buffer.from([0x53, 0x45, 0x4c, 0xe9, 0x3b]));

    const error = await readSqlFile(path).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SqlFileError);
    expect((error as SqlFileError).message).toBe("latin1.sql is not UTF-8 text: byte 3 starts an invalid sequence.");
  });

  it("givenMissingOrRelativePath_whenRead_thenSqlFileError", async () => {
    await expect(readSqlFile(join(folder, "gone.sql"))).rejects.toBeInstanceOf(SqlFileError);
    await expect(readSqlFile("relative.sql")).rejects.toBeInstanceOf(SqlFileError);
  });

  it("givenFile_whenRenamed_thenMovedInItsFolderAndNamesChecked", async () => {
    const path = await fileWith("a.sql", "x");
    await fileWith("taken.sql", "y");

    expect(await renameSqlFile(path, " b.sql ")).toEqual({ path: join(folder, "b.sql") });
    expect(await readFile(join(folder, "b.sql"), "utf8")).toBe("x");
    await expect(renameSqlFile(join(folder, "b.sql"), "taken.sql")).rejects.toThrow("already exists");
    await expect(renameSqlFile(join(folder, "b.sql"), "../out.sql")).rejects.toThrow("cannot name a file");
    await expect(renameSqlFile(join(folder, "b.sql"), "..")).rejects.toThrow("cannot name a file");
  });

  it("givenPaths_whenStat_thenModifiedTimeOrNullWhenGone", async () => {
    const path = await fileWith("here.sql", "x");

    expect(await statSqlFiles([path, join(folder, "gone.sql")])).toEqual([(await stat(path)).mtimeMs, null]);
  });

  it("givenChannels_whenOpenWriteRename_thenRecentFilesFollow", async () => {
    const first = await fileWith("first.sql", "a");
    const second = await fileWith("second.sql", "b");
    const recents: (readonly string[])[] = [];
    const attachments = createFileAttachments({ path: "/profile/fileAttachments.json", files: memoryFiles() });
    const channels = createSqlFileChannels<null>({
      attachments,
      choose: () => Promise.resolve([]),
      recentChanged: (recent) => recents.push(recent),
    });
    await channels.attach(first, { datasourceId: "pg", namespace: ["public"] });

    expect((await channels.open(first)).attachment).toEqual({ datasourceId: "pg", namespace: ["public"] });
    await channels.read(second);
    await channels.write(second, "c", "lf");
    const renamed = await channels.rename(first, "renamed.sql");

    expect(recents.at(-1)).toEqual([renamed.path, second]);
    expect(await attachments.attachmentOf(renamed.path)).toEqual({ datasourceId: "pg", namespace: ["public"] });
    expect(await attachments.attachmentOf(first)).toBeNull();
  });
});
