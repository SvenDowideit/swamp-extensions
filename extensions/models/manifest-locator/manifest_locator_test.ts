import { assertEquals } from "jsr:@std/assert@1";
import { findManifestPath, parseManifestVersion } from "./manifest_locator.ts";

const MANIFEST = `manifestVersion: 1\nname: "@x/y"\nversion: "2026.10.10.2"\n`;

/** A `ctx.extensionFile` look-alike: resolve, and throw when the path is absent. */
function resolver(root: string) {
  return (relPath: string): string => {
    const path = `${root.replace(/\/+$/, "")}/${relPath}`;
    try {
      Deno.statSync(path);
    } catch {
      throw new Error(`Extension file not found: ${relPath}`);
    }
    return path;
  };
}

Deno.test("findManifestPath resolves the source layout", () => {
  const ext = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${ext}/manifest.yaml`, MANIFEST);
  Deno.writeTextFileSync(`${ext}/README.md`, "readme");

  assertEquals(findManifestPath(resolver(ext)), `${ext}/manifest.yaml`);
});

Deno.test("findManifestPath resolves the pulled layout (manifest above files/)", () => {
  const ext = Deno.makeTempDirSync();
  Deno.mkdirSync(`${ext}/files`, { recursive: true });
  Deno.writeTextFileSync(`${ext}/manifest.yaml`, MANIFEST);
  Deno.writeTextFileSync(`${ext}/files/README.md`, "readme");

  // A pulled extension resolves assets under <ext>/files/, never at <ext>/.
  assertEquals(findManifestPath(resolver(`${ext}/files`)), `${ext}/manifest.yaml`);
});

Deno.test("findManifestPath resolves via the empty-string root anchor", () => {
  const ext = Deno.makeTempDirSync();
  Deno.mkdirSync(`${ext}/files`, { recursive: true });
  Deno.writeTextFileSync(`${ext}/manifest.yaml`, MANIFEST);

  // Only the root anchor ("") resolves; the file anchors are absent.
  assertEquals(findManifestPath(resolver(`${ext}/files`)), `${ext}/manifest.yaml`);
});

Deno.test("findManifestPath returns empty when no manifest exists", () => {
  const ext = Deno.makeTempDirSync();
  assertEquals(findManifestPath(resolver(ext)), "");
});

Deno.test("parseManifestVersion reads the version line", () => {
  assertEquals(parseManifestVersion(MANIFEST), "2026.10.10.2");
  assertEquals(parseManifestVersion("version: 1.2.3\n"), "1.2.3");
  assertEquals(parseManifestVersion("name: x\n"), "");
});
