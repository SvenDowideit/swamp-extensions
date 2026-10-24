import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  buildPixiecoreCommand,
  containerNameFor,
  resolveImage,
  serviceModelName,
} from "./pixiecore.ts";
import type { GlobalArgs } from "./pixiecore.ts";

Deno.test("containerNameFor derives a name", () => {
  assertEquals(containerNameFor("pixie", ""), "pixie");
  assertEquals(containerNameFor("my host", "custom"), "custom");
});

Deno.test("serviceModelName appends -svc", () => {
  assertEquals(serviceModelName("pixie", ""), "pixie-svc");
});

Deno.test("buildPixiecoreCommand serves netboot.xyz on 0.0.0.0", () => {
  const cfg = {
    name: "pixie",
    image: "pixiecore/pixiecore:master",
    containerName: "",
    serviceBackend: "direct" as const,
    listenAddr: "0.0.0.0",
    httpPort: 80,
    statusPort: 0,
    dhcpNoBind: true,
    debug: false,
    restart: "unless-stopped",
    binary: "docker",
  };
  const cmd = buildPixiecoreCommand(cfg as unknown as GlobalArgs);
  assertEquals(cmd[0], "quick");
  assertEquals(cmd[1], "xyz");
  assertStringIncludes(cmd.join(" "), "0.0.0.0");
  assertStringIncludes(cmd.join(" "), "--dhcp-no-bind");
});

Deno.test("resolveImage prefers override", () => {
  const cfg = {
    image: "base:latest",
    name: "",
    containerName: "",
    serviceBackend: "direct" as const,
    listenAddr: "0.0.0.0",
    httpPort: 80,
    statusPort: 0,
    dhcpNoBind: true,
    debug: false,
    restart: "unless-stopped",
    binary: "docker",
  };
  assertEquals(
    resolveImage(cfg as unknown as GlobalArgs, "other:tag"),
    "other:tag",
  );
  assertEquals(resolveImage(cfg as unknown as GlobalArgs), "base:latest");
});
