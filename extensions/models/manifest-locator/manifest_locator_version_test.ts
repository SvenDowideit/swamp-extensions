import { assert, assertNotEquals } from "jsr:@std/assert@1";
import { model, parseManifestVersion } from "./manifest_locator.ts";

/**
 * The extension (package) version in `manifest.yaml` and the model-type
 * (schema) version in the exported `model` object are independent in swamp: an
 * unchanged model keeps its version across extension releases. This guard
 * fails if something (e.g. release tooling that writes both) collapses them
 * back to the same value.
 */
Deno.test("model schema version stays different from the extension manifest version", async () => {
  const manifestUrl = new URL("./manifest.yaml", import.meta.url);
  const manifestVersion = parseManifestVersion(
    await Deno.readTextFile(manifestUrl),
  );

  assert(
    manifestVersion !== "",
    "manifest.yaml must declare a top-level version",
  );
  assertNotEquals(
    model.version,
    manifestVersion,
    "the model schema version must not be bumped to the extension version",
  );
});
