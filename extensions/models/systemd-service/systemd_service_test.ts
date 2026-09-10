import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { expandHome, renderServiceUnit } from "./systemd_service.ts";

Deno.test("expandHome expands a leading ~ to the home directory", () => {
  assertEquals(expandHome("~", "/home/alice"), "/home/alice");
  assertEquals(
    expandHome("~/.config/systemd/user", "/home/alice"),
    "/home/alice/.config/systemd/user",
  );
  assertEquals(
    expandHome("/usr/lib/systemd/user", "/home/alice"),
    "/usr/lib/systemd/user",
  );
});

Deno.test("renderServiceUnit renders a minimal unit with defaults", () => {
  const unit = renderServiceUnit({
    serviceName: "feedback-server",
    command: "~/.swamp/deno/deno run --allow-net scripts/feedback-server.ts",
    environment: [],
    restart: "on-failure",
    restartSec: "5",
    after: ["network-online.target"],
    wants: ["network-online.target"],
  });
  assertStringIncludes(unit, "[Unit]");
  assertStringIncludes(unit, "Description=feedback-server");
  assertStringIncludes(unit, "After=network-online.target");
  assertStringIncludes(unit, "Wants=network-online.target");
  assertStringIncludes(unit, "[Service]");
  assertStringIncludes(
    unit,
    "ExecStart=~/.swamp/deno/deno run --allow-net scripts/feedback-server.ts",
  );
  assertStringIncludes(unit, "Restart=on-failure");
  assertStringIncludes(unit, "RestartSec=5");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("renderServiceUnit includes description, working dir, and env", () => {
  const unit = renderServiceUnit({
    serviceName: "api",
    command: "/usr/bin/api --port 8080",
    description: "My API server",
    workingDirectory: "/srv/api",
    environment: ["PORT=8080", "LOG_LEVEL=info"],
    restart: "always",
    restartSec: "2",
    after: ["network-online.target", "multi-user.target"],
    wants: ["network-online.target"],
  });
  assertStringIncludes(unit, "Description=My API server");
  assertStringIncludes(unit, "WorkingDirectory=/srv/api");
  assertStringIncludes(unit, "Environment=PORT=8080");
  assertStringIncludes(unit, "Environment=LOG_LEVEL=info");
  assertStringIncludes(unit, "Restart=always");
  assertStringIncludes(unit, "RestartSec=2");
  assertStringIncludes(unit, "After=multi-user.target");
});
