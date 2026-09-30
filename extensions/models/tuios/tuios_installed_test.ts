/**
 * Unit tests for the `tuios-installed` model's pure helpers — candidate
 * install paths, home expansion and the printed installed summary. No network
 * or binary execution is involved.
 *
 * @module
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  existingBinary,
  findBinary,
  formatSummary,
  searchPaths,
  serviceStatusCommand,
} from "./tuios_installed.ts";
import { expandHome, selectInstallDir } from "./tuios_shared.ts";

Deno.test("expandHome expands a leading ~ only", () => {
  assertEquals(expandHome("~", "/home/me"), "/home/me");
  assertEquals(expandHome("~/.local/bin", "/home/me"), "/home/me/.local/bin");
  assertEquals(expandHome("/usr/bin", "/home/me"), "/usr/bin");
});

Deno.test("searchPaths lists the auto-detection candidates in order", () => {
  const paths = searchPaths("/home/me");
  assertEquals(paths[0], "tuios");
  assertEquals(paths.includes("/home/me/.local/bin/tuios"), true);
  assertEquals(paths.includes("/home/me/bin/tuios"), true);
  assertEquals(paths.includes("/usr/local/bin/tuios"), true);
});

Deno.test("findBinary treats an explicit path as authoritative", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/tuios`, "binary");
    // Present explicit path resolves to itself.
    assertEquals(await findBinary(`${tmpDir}/tuios`), `${tmpDir}/tuios`);
    // A missing explicit path must NOT fall through to PATH/auto-detection,
    // even though this host has a tuios on PATH.
    assertEquals(await findBinary("/nonexistent/tuios-xyz"), null);
    // `~` is expanded.
    assertEquals(await findBinary("~/nonexistent-tuios", tmpDir), null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("existingBinary does not fall back to PATH", async () => {
  assertEquals(await existingBinary("/nonexistent/tuios-xyz"), null);
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

Deno.test("serviceStatusCommand builds the systemctl command or null", () => {
  assertEquals(
    serviceStatusCommand({ globalArgs: { serviceName: "tuios" } }),
    "systemctl --user status tuios.service",
  );
  assertEquals(
    serviceStatusCommand({ globalArgs: { serviceName: "tuios-dev" } }),
    "systemctl --user status tuios-dev.service",
  );
  assertEquals(
    serviceStatusCommand({ globalArgs: { serviceName: "" } }),
    null,
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
  }, "tuios").join("\n");
  assertEquals(present.includes("Installed:    0.8.0"), true);
  assertEquals(present.includes("Backend:      pure-Go backend"), true);
  assertEquals(
    present.includes("Binary:       /home/me/.local/bin/tuios"),
    true,
  );
  assertEquals(
    present.includes("systemctl --user status tuios.service"),
    true,
  );
  assertEquals(present.includes("(up to date)"), true);

  const absent = formatSummary({
    present: false,
    latestVersion: "0.8.0",
  }).join("\n");
  assertEquals(absent.includes("not installed"), true);
  assertEquals(absent.includes("Latest release: 0.8.0"), true);
  assertFalse(absent.includes("Backend"));
});
