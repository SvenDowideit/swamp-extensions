import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  distroDockerfile,
  distroImageTag,
  dockerUnavailable,
  runDetached,
  type RunFn,
  stripAnsi,
} from "./docker.ts";
import { distroByName } from "./scenarios.ts";

Deno.test("runDetached passes capability sysctls to docker run", async () => {
  let seen: string[] = [];
  const runFn: RunFn = (_bin, args) => {
    seen = args;
    return Promise.resolve({ stdout: "abc123\n", stderr: "", code: 0 });
  };
  const created = await runDetached(runFn, {
    name: "tf-test",
    image: "ubuntu:24.04",
    sysctls: { "net.ipv4.ip_unprivileged_port_start": "1024" },
  });
  assertEquals(created.id, "abc123");
  assertStringIncludes(
    seen.join(" "),
    "--sysctl net.ipv4.ip_unprivileged_port_start=1024",
  );
});

Deno.test("stripAnsi removes SGR colour codes", () => {
  assertEquals(stripAnsi("\u001b[31mred\u001b[0m"), "red");
});

Deno.test("dockerUnavailable recognises a missing daemon", () => {
  assertEquals(
    dockerUnavailable({
      stdout: "",
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      code: 1,
    }),
    true,
  );
  assertEquals(
    dockerUnavailable({ stdout: "", stderr: "boom", code: 1 }),
    false,
  );
  assertEquals(dockerUnavailable({ stdout: "", stderr: "", code: 127 }), true);
});

Deno.test("distroImageTag encodes distro and systemd", () => {
  const debian = distroByName("debian")!;
  assertEquals(
    distroImageTag(debian, false),
    "swamp-test-factory/debian:latest",
  );
  assertEquals(
    distroImageTag(debian, true),
    "swamp-test-factory/debian-systemd:latest",
  );
});

Deno.test("a non-systemd debian Dockerfile has no init and installs prereqs", () => {
  const df = distroDockerfile(distroByName("debian")!, false);
  assertStringIncludes(df, "FROM debian:bookworm-slim");
  assertStringIncludes(df, "ca-certificates");
  assertStringIncludes(df, 'CMD ["sleep", "infinity"]');
  assertEquals(df.includes("systemd"), false);
});

Deno.test("a systemd debian Dockerfile installs systemd and boots it", () => {
  const df = distroDockerfile(distroByName("debian")!, true);
  assertStringIncludes(df, "systemd");
  assertStringIncludes(df, 'CMD ["/sbin/init"]');
});

Deno.test("the rpm Dockerfile does not reinstall conflicting curl", () => {
  const df = distroDockerfile(distroByName("rocky")!, false);
  assertStringIncludes(df, "FROM rockylinux:9");
  // Rocky 9 ships curl-minimal; installing `curl` conflicts with it.
  assertEquals(
    /(^|\s)curl(\s|\\|$)/.test(df.replace(/curl-minimal/g, "")),
    false,
  );
});

Deno.test("the apk Dockerfile is tolerant of missing packages", () => {
  const df = distroDockerfile(distroByName("wolfi")!, false);
  assertStringIncludes(df, "FROM cgr.dev/chainguard/wolfi-base:latest");
  assertStringIncludes(df, "apk add");
  assertStringIncludes(df, "true");
});
