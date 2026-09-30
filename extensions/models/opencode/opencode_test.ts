/**
 * Unit tests for the `@svendowideit/opencode` model's pure helpers — binary
 * lookup and the printed summary. No network or binary execution is involved.
 *
 * @module
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  existingBinary,
  findBinary,
  formatSummary,
  searchPaths,
} from "./opencode.ts";

Deno.test("searchPaths lists the auto-detection candidates in order", () => {
  const paths = searchPaths("/home/me");
  assertEquals(paths[0], "opencode");
  assertEquals(paths.includes("/home/me/.opencode/bin/opencode"), true);
  assertEquals(paths.includes("/home/me/.local/bin/opencode"), true);
  assertEquals(paths.includes("/usr/local/bin/opencode"), true);
});

Deno.test("findBinary treats an explicit path as authoritative", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/opencode`, "binary");
    assertEquals(await findBinary(`${tmpDir}/opencode`), `${tmpDir}/opencode`);
    assertEquals(await findBinary("/nonexistent/opencode-xyz"), null);
    assertEquals(await findBinary("~/nonexistent-opencode", tmpDir), null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("existingBinary does not fall back to PATH", async () => {
  assertEquals(await existingBinary("/nonexistent/opencode-xyz"), null);
});

Deno.test("formatSummary handles present and absent", () => {
  const present = formatSummary({
    present: true,
    version: "1.18.33",
    path: "/home/me/.opencode/bin/opencode",
    theme: "borland_modern_blue",
    themeInstalled: true,
    tuiPath: "/home/me/.config/opencode/tui.json",
  }).join("\n");
  assertEquals(present.includes("Installed:    1.18.33"), true);
  assertEquals(present.includes("borland_modern_blue (installed)"), true);
  assertEquals(present.includes("TUI config:"), true);

  const absent = formatSummary({ present: false }).join("\n");
  assertEquals(absent.includes("not installed"), true);
  assertFalse(absent.includes("Installed:"));
});
