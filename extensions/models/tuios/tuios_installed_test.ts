/**
 * Unit tests for the `tuios-installed` model's pure helpers — candidate
 * install paths, home expansion and the printed installed summary. No network
 * or binary execution is involved.
 *
 * @module
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@1";
import { candidatePaths, formatSummary } from "./tuios_installed.ts";
import { expandHome, selectInstallDir } from "./tuios_shared.ts";

Deno.test("expandHome expands a leading ~ only", () => {
  assertEquals(expandHome("~", "/home/me"), "/home/me");
  assertEquals(expandHome("~/.local/bin", "/home/me"), "/home/me/.local/bin");
  assertEquals(expandHome("/usr/bin", "/home/me"), "/usr/bin");
});

Deno.test("candidatePaths puts an explicit path first and de-duplicates", () => {
  const paths = candidatePaths("~/.local/bin/tuios", "/home/me");
  assertEquals(paths[0], "/home/me/.local/bin/tuios");
  assertEquals(new Set(paths).size, paths.length);
  assertEquals(paths.includes("tuios"), true);
  assertEquals(paths.includes("/usr/local/bin/tuios"), true);
});

Deno.test("selectInstallDir picks the first writable candidate", () => {
  assertEquals(
    selectInstallDir("/home/me", (dir) => dir === "/usr/local/bin"),
    "/usr/local/bin",
  );
  assertEquals(
    selectInstallDir("/home/me", (dir) => dir === "/home/me/.local/bin"),
    "/home/me/.local/bin",
  );
  // Nothing writable yet — falls back to the user-writable location.
  assertEquals(
    selectInstallDir("/home/me", () => false),
    "/home/me/.local/bin",
  );
});

Deno.test("installed formatSummary handles present and absent", () => {
  const present = formatSummary({
    present: true,
    version: "0.8.0",
    backend: "pure-Go backend",
    path: "/home/me/.local/bin/tuios",
    latestVersion: "0.8.0",
    updateAvailable: false,
  }).join("\n");
  assertEquals(present.includes("Installed:    0.8.0"), true);
  assertEquals(present.includes("Backend:      pure-Go backend"), true);
  assertEquals(present.includes("(up to date)"), true);

  const absent = formatSummary({
    present: false,
    latestVersion: "0.8.0",
  }).join("\n");
  assertEquals(absent.includes("not installed"), true);
  assertEquals(absent.includes("Latest release: 0.8.0"), true);
  assertFalse(absent.includes("Backend"));
});
