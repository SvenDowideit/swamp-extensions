import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  GRANT_PROFILES,
  grantProfileById,
  planGrants,
  renderGrantScript,
} from "./grants.ts";

Deno.test("every declared grant profile has a unique id", () => {
  const ids = GRANT_PROFILES.map((g) => g.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("the T0-nr subset is implemented", () => {
  for (
    const id of [
      "user-tester",
      "sudo-nopasswd",
      "sudo-none",
      "sudo-interactive-only",
      "doas-nopasswd",
      "no-grant",
    ]
  ) {
    assertEquals(grantProfileById(id)?.implemented, true, id);
  }
});

Deno.test("a not-yet-built tier grant throws rather than silently no-op-ing", () => {
  const docker = grantProfileById("docker-rootful")!;
  assertEquals(docker.implemented, false);
  assertThrows(() => renderGrantScript(docker));
});

Deno.test("user-tester creates a non-root user", () => {
  const s = renderGrantScript(grantProfileById("user-tester")!);
  assertStringIncludes(s, "useradd -m -s /bin/bash tester");
  assertStringIncludes(s, "chown -R tester /home/tester");
});

Deno.test("sudo-nopasswd writes a NOPASSWD rule", () => {
  const s = renderGrantScript(grantProfileById("sudo-nopasswd")!);
  assertStringIncludes(s, "/etc/sudoers.d/010-tester");
  assertStringIncludes(s, "NOPASSWD: ALL");
});

Deno.test("sudo-interactive-only has no NOPASSWD", () => {
  const s = renderGrantScript(grantProfileById("sudo-interactive-only")!);
  assertStringIncludes(s, "ALL=(ALL) ALL");
  assertEquals(s.includes("NOPASSWD"), false);
});

Deno.test("doas-nopasswd writes a permit-nopass rule", () => {
  const s = renderGrantScript(grantProfileById("doas-nopasswd")!);
  assertStringIncludes(s, "permit nopass tester");
  assertStringIncludes(s, "/etc/doas.conf");
});

Deno.test("planGrants separates scripts, pending tiers and unknown ids", () => {
  const plan = planGrants([
    { guest: "harness", profile: "user-tester" },
    { guest: "harness", profile: "docker-rootful" },
    { guest: "harness", profile: "does-not-exist" },
  ]);
  assertEquals(plan.scripts.length, 1);
  assertEquals(plan.scripts[0].profile, "user-tester");
  assertEquals(plan.pending.length, 1);
  assertStringIncludes(plan.pending[0].reason, "T1 tier");
  assertEquals(plan.unknown.length, 1);
});

Deno.test("planGrants preserves declaration order (first-win)", () => {
  const plan = planGrants([
    { guest: "harness", profile: "sudo-nopasswd" },
    { guest: "harness", profile: "doas-nopasswd" },
  ]);
  assertEquals(plan.scripts.map((s) => s.profile), [
    "sudo-nopasswd",
    "doas-nopasswd",
  ]);
});
