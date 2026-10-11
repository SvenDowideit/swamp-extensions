import { assertEquals } from "jsr:@std/assert@1";
import { gateViolations } from "./gate.ts";

Deno.test("a model implementation change with no test change is a violation", () => {
  const v = gateViolations([
    "extensions/models/caddy/caddy.ts",
    "extensions/models/caddy/manifest.yaml",
  ]);
  assertEquals(v.length > 0, true);
  assertEquals(v.join("\n").includes("caddy.ts"), true);
});

Deno.test("a shipped workflow change with no test change is a violation", () => {
  const v = gateViolations(["extensions/models/caddy/caddy-upgrade.yaml"]);
  assertEquals(v.length > 0, true);
});

Deno.test("a behaviour change WITH a test change passes", () => {
  assertEquals(
    gateViolations([
      "extensions/models/caddy/caddy.ts",
      "extensions/models/caddy/caddy_test.ts",
    ]),
    [],
  );
  assertEquals(
    gateViolations([
      "extensions/models/caddy/caddy.ts",
      "extensions/models/caddy/test-factory.yaml",
    ]),
    [],
  );
  assertEquals(
    gateViolations([
      "extensions/models/caddy/caddy-setup.yaml",
      "extensions/models/caddy/test/bind/Dockerfile.txt",
    ]),
    [],
  );
});

Deno.test("docs, manifests and version bumps pass alone", () => {
  assertEquals(gateViolations(["extensions/models/caddy/manifest.yaml"]), []);
  assertEquals(gateViolations(["extensions/models/caddy/README.md"]), []);
  assertEquals(gateViolations(["docs/caddy-test-matrix.md"]), []);
  assertEquals(gateViolations(["scripts/fleet/gate.ts"]), []);
});

Deno.test("a test-only change passes", () => {
  assertEquals(
    gateViolations(["extensions/models/caddy/caddy_test.ts"]),
    [],
  );
});
