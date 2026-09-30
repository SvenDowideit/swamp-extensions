/**
 * Unit tests for the `@svendowideit/opencode` shared helpers — version parsing,
 * path/install-dir selection, the package-manager probe, tar extraction, and
 * the theme/tui.json file helpers.
 *
 * @module
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@0.1.10/tar-stream";
import {
  assertAbsoluteDir,
  compareVersions,
  DEFAULT_THEME,
  detectPackageManagerOwner,
  expandHome,
  extractFromTarGz,
  isOnPath,
  mergeTuiTheme,
  normalizeVersion,
  parseVersionOutput,
  readTuiTheme,
  selectInstallDir,
  sha256Hex,
  themeFilePath,
  themesDir,
  tuiConfigPath,
  validateTheme,
  verifySha256,
  versionsEqual,
} from "./opencode_shared.ts";

Deno.test("normalizeVersion strips a leading v", () => {
  assertEquals(normalizeVersion("v1.18.33"), "1.18.33");
  assertEquals(normalizeVersion("1.18.33"), "1.18.33");
  assertEquals(normalizeVersion(" v1.18.33 "), "1.18.33");
});

Deno.test("parseVersionOutput reads a bare or v-prefixed version", () => {
  assertEquals(parseVersionOutput("1.18.33"), "1.18.33");
  assertEquals(parseVersionOutput("v1.18.33\n"), "1.18.33");
  assertEquals(parseVersionOutput("opencode 1.18.33"), "1.18.33");
  assertEquals(parseVersionOutput("1.18.33-beta.1"), "1.18.33-beta.1");
  assertEquals(parseVersionOutput("command not found"), null);
});

Deno.test("compareVersions orders numerically", () => {
  assertEquals(compareVersions("1.10.0", "1.9.0"), 1);
  assertEquals(compareVersions("v1.18.33", "1.18.33"), 0);
  assertEquals(versionsEqual("v1.18.33", "1.18.33"), true);
});

Deno.test("expandHome expands a leading ~ only", () => {
  assertEquals(expandHome("~", "/home/me"), "/home/me");
  assertEquals(
    expandHome("~/.config/opencode", "/home/me"),
    "/home/me/.config/opencode",
  );
  assertEquals(expandHome("/etc/opencode", "/home/me"), "/etc/opencode");
});

Deno.test("selectInstallDir prefers the upstream ~/.opencode/bin", () => {
  assertEquals(
    selectInstallDir("/home/me", (d) => d === "/home/me/.opencode/bin"),
    "/home/me/.opencode/bin",
  );
  assertEquals(
    selectInstallDir("/home/me", (d) => d === "/usr/local/bin"),
    "/usr/local/bin",
  );
  assertEquals(
    selectInstallDir("/home/me", () => false),
    "/home/me/.opencode/bin",
  );
});

Deno.test("isOnPath matches a directory on PATH", () => {
  assertEquals(isOnPath("/usr/bin", "/usr/bin:/bin"), true);
  assertEquals(isOnPath("/nope", "/usr/bin:/bin"), false);
});

Deno.test("assertAbsoluteDir accepts absolute, ~ and empty; rejects relative", () => {
  assertAbsoluteDir("/usr/local/bin", "installDir");
  assertAbsoluteDir("~/.opencode/bin", "installDir");
  assertAbsoluteDir("", "installDir");
  assertThrows(
    () => assertAbsoluteDir("relative/bin", "installDir"),
    Error,
    "absolute",
  );
});

Deno.test("detectPackageManagerOwner reads dpkg, rpm and brew", async () => {
  const dpkg = (bin: string, args: string[]) =>
    bin === "dpkg" && args[0] === "-S"
      ? Promise.resolve({
        stdout: "opencode: /usr/bin/opencode\n",
        stderr: "",
        code: 0,
      })
      : Promise.resolve({ stdout: "", stderr: "", code: 1 });
  assertEquals(
    await detectPackageManagerOwner("/usr/bin/opencode", dpkg),
    "opencode",
  );
  const rpm = (bin: string, args: string[]) =>
    bin === "rpm" && args[0] === "-qf"
      ? Promise.resolve({
        stdout: "opencode-1.18.33-1.x86_64\n",
        stderr: "",
        code: 0,
      })
      : Promise.resolve({ stdout: "", stderr: "", code: 1 });
  assertEquals(
    await detectPackageManagerOwner("/usr/bin/opencode", rpm),
    "opencode-1.18.33-1.x86_64",
  );
  const brew = (bin: string, args: string[]) =>
    bin === "brew" && args[0] === "list"
      ? Promise.resolve({ stdout: "opencode\n", stderr: "", code: 0 })
      : Promise.resolve({ stdout: "", stderr: "", code: 1 });
  assertEquals(
    await detectPackageManagerOwner("/opt/homebrew/bin/opencode", brew),
    "brew formula 'opencode'",
  );
});

Deno.test("sha256Hex and verifySha256", async () => {
  const bytes = new TextEncoder().encode("hello");
  const sum = await sha256Hex(bytes);
  assertEquals(
    sum,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assertEquals(await verifySha256(bytes, sum), true);
  assertEquals(await verifySha256(bytes, ""), true);
  assertEquals(await verifySha256(bytes, "0".repeat(64)), false);
});

Deno.test("extractFromTarGz returns the named member", async () => {
  const enc = new TextEncoder();
  const body = enc.encode("the binary");
  const entry: TarStreamInput = {
    type: "file",
    path: "./opencode",
    size: body.length,
    readable: new Blob([body]).stream(),
  };
  const tar = new TarStream();
  const writer = tar.writable.getWriter();
  const collected = new Response(tar.readable).arrayBuffer();
  await writer.write(entry);
  await writer.close();
  const tarBytes = new Uint8Array(await collected);
  const gz = new Blob([tarBytes]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
  const found = await extractFromTarGz(bytes, "opencode");
  assertEquals(new TextDecoder().decode(found!), "the binary");
  assertEquals(await extractFromTarGz(bytes, "README.md"), null);
});

Deno.test("theme paths hang off the config dir", () => {
  assertEquals(
    themesDir("/home/me/.config/opencode"),
    "/home/me/.config/opencode/themes",
  );
  assertEquals(
    themeFilePath("/home/me/.config/opencode", "borland_modern_blue"),
    "/home/me/.config/opencode/themes/borland_modern_blue.json",
  );
  assertEquals(
    tuiConfigPath("/home/me/.config/opencode"),
    "/home/me/.config/opencode/tui.json",
  );
});

Deno.test("validateTheme requires theme and defs objects", () => {
  validateTheme("ok", { theme: {}, defs: {} });
  assertThrows(
    () => validateTheme("bad", {} as Record<string, unknown>),
    Error,
    "theme",
  );
  assertThrows(
    () => validateTheme("bad", { theme: {} } as Record<string, unknown>),
    Error,
    "defs",
  );
});

Deno.test("mergeTuiTheme preserves other keys and sets the theme", () => {
  const merged = mergeTuiTheme(
    JSON.stringify({ $schema: "x", keybinds: { a: "b" }, theme: "old" }),
    "borland_modern_blue",
  );
  const parsed = JSON.parse(merged);
  assertEquals(parsed.theme, "borland_modern_blue");
  assertEquals(parsed.keybinds, { a: "b" });
  assertEquals(parsed.$schema, "x");
});

Deno.test("mergeTuiTheme repairs a malformed tui.json", () => {
  const merged = mergeTuiTheme("{not json", "borland_modern_blue");
  const parsed = JSON.parse(merged);
  assertEquals(parsed.theme, "borland_modern_blue");
  assertEquals(parsed.$schema, "https://opencode.ai/tui.json");
});

Deno.test("readTuiTheme reads the theme or null", () => {
  assertEquals(readTuiTheme(JSON.stringify({ theme: "nord" })), "nord");
  assertEquals(readTuiTheme(null), null);
  assertEquals(readTuiTheme("{bad"), null);
  assertEquals(readTuiTheme(JSON.stringify({})), null);
});

Deno.test("DEFAULT_THEME is the shipped Borland theme", () => {
  assertEquals(DEFAULT_THEME, "borland_modern_blue");
});
