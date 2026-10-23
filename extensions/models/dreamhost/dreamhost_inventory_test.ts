import { assertEquals } from "jsr:@std/assert@1";

import {
  executeHomeManifest,
  parseFindManifest,
  parseGrepLines,
  parseMailLines,
  parseSpecialLines,
  redactDatabaseLine,
} from "./dreamhost_inventory.ts";

type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

Deno.test("parseFindManifest handles NUL records and tabs in paths", () => {
  const stdout =
    "f\t10\t123\t644\tu\tg\t\tfirst.txt\0d\t0\t124\t755\tu\tg\t\tweird\tname.txt\0";
  const entries = parseFindManifest(stdout);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].path, "first.txt");
  assertEquals(entries[1].path, "weird\tname.txt");
  assertEquals(entries[1].type, "d");
});

Deno.test("redactDatabaseLine redacts sensitive values", () => {
  assertEquals(
    redactDatabaseLine(`DB_PASSWORD='secret'; DB_NAME='mydb'`),
    `DB_PASSWORD='[REDACTED]'; DB_NAME='mydb'`,
  );
});

Deno.test("parseGrepLines retains database names but redacts passwords", () => {
  const stdout =
    "/home/u/.env:2:DB_PASSWORD=secret\n/home/u/.env:3:DB_NAME=mydb\n";
  const refs = parseGrepLines(stdout);
  assertEquals(refs.length, 2);
  assertEquals(refs[0].redactedMatch, "DB_PASSWORD=[REDACTED]");
  assertEquals(refs[1].redactedMatch, "DB_NAME=mydb");
});

Deno.test("parseMailLines parses NUL mail entries", () => {
  const stdout =
    "/home/u/Maildir\tmaildir\t42\t10\0/home/u/mail\tmaildir\t1\t2\0";
  const entries = parseMailLines(stdout);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].sizeKb, 42);
  assertEquals(entries[1].fileCount, 2);
});

Deno.test("parseSpecialLines preserves symlink targets and paths with tabs", () => {
  const stdout = "l\t/the/target\t777\tlink\tname\0";
  const entries = parseSpecialLines(stdout);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].target, "/the/target");
  assertEquals(entries[0].path, "link\tname");
});

Deno.test("executeHomeManifest caps entries and reports truncation", async () => {
  const runner: CommandRunner = (bin, args) => {
    if (bin === "ssh" && args.some((a) => a.includes("find"))) {
      return Promise.resolve({
        stdout:
          "f\t1\t1\t644\tu\tg\t\tone.txt\0f\t2\t2\t644\tu\tg\t\ttwo.txt\0",
        stderr: "",
        code: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  };
  const outcome = await executeHomeManifest(
    {
      host: "h",
      user: "u",
      port: 22,
      sshOptions: [],
    } as never,
    { root: "~", maxEntries: 1 },
    runner,
  );
  assertEquals(outcome.entryCount, 1);
  assertEquals(outcome.truncated, true);
});
