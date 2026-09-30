/**
 * Unit tests for the `tuios-installed` model's pure helpers — candidate
 * install paths, binary lookup and the printed installed summary. No network
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
    assertEquals(await findBinary(`${tmpDir}/tuios`), `${tmpDir}/tuios`);
    // A missing explicit path must NOT fall through to PATH/auto-detection.
    assertEquals(await findBinary("/nonexistent/tuios-xyz"), null);
    assertEquals(await findBinary("~/nonexistent-tuios", tmpDir), null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("existingBinary does not fall back to PATH", async () => {
  assertEquals(await existingBinary("/nonexistent/tuios-xyz"), null);
});

Deno.test("serviceStatusCommand builds the systemctl command or null", () => {
  assertEquals(
    serviceStatusCommand({ globalArgs: { serviceName: "tuios" } }),
    "systemctl --user status tuios.service",
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

  const absent = formatSummary({ present: false }).join("\n");
  assertEquals(absent.includes("not installed"), true);
  assertFalse(absent.includes("Backend"));
});
