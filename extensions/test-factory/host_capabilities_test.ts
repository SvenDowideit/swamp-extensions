import { assertEquals } from "jsr:@std/assert@1";
import type { CmdResult, RunFn } from "./docker.ts";
import {
  CAPABILITY_KEYS,
  capabilityMatrix,
  fabricAvailable,
  interpretCapabilities,
  kvmBackendAvailable,
  kvmUnavailableReason,
  probeHostCapabilities,
} from "./host_capabilities.ts";

function ok(stdout = ""): CmdResult {
  return { stdout, stderr: "", code: 0 };
}

function fail(stderr = "nope"): CmdResult {
  return { stdout: "", stderr, code: 1 };
}

Deno.test("interpretCapabilities: all present", () => {
  const caps = interpretCapabilities({
    docker: ok("29.1.3"),
    kvmDevice: ok(),
    accelInit: ok(),
    tunDevice: ok(),
    netAdmin: ok(),
  });
  assertEquals(caps.container, true);
  assertEquals(caps.kvm, true);
  assertEquals(caps.tun, true);
  assertEquals(caps.netAdmin, true);
  assertEquals(caps.runtimeVersion, "29.1.3");
  assertEquals(kvmBackendAvailable(caps), true);
  assertEquals(fabricAvailable(caps), true);
  assertEquals(kvmUnavailableReason(caps), "");
});

Deno.test("interpretCapabilities: device node present but accel init fails is not KVM", () => {
  const caps = interpretCapabilities({
    docker: ok("29.1.3"),
    kvmDevice: ok(),
    accelInit: fail("KVM not supported"),
    tunDevice: ok(),
    netAdmin: ok(),
  });
  assertEquals(caps.kvm, false);
  assertEquals(kvmBackendAvailable(caps), false);
  // the detail names the real cause, not the misleading device node.
  assertEquals(caps.detail.kvm.includes("accelerator init failed"), true);
});

Deno.test("interpretCapabilities: no container runtime", () => {
  const caps = interpretCapabilities({
    docker: fail("Cannot connect to the Docker daemon"),
    kvmDevice: ok(),
    accelInit: ok(),
    tunDevice: ok(),
    netAdmin: ok(),
  });
  assertEquals(caps.container, false);
  assertEquals(kvmBackendAvailable(caps), false);
  assertEquals(
    kvmUnavailableReason(caps).includes("no container runtime"),
    true,
  );
});

Deno.test("fabric requires TUN and NET_ADMIN beyond KVM", () => {
  const caps = interpretCapabilities({
    docker: ok("29.1.3"),
    kvmDevice: ok(),
    accelInit: ok(),
    tunDevice: fail(),
    netAdmin: ok(),
  });
  assertEquals(kvmBackendAvailable(caps), true);
  assertEquals(fabricAvailable(caps), false);
});

Deno.test("capabilityMatrix lists every capability in order", () => {
  const caps = interpretCapabilities({
    docker: ok("29.1.3"),
    kvmDevice: ok(),
    accelInit: ok(),
    tunDevice: ok(),
    netAdmin: ok(),
  });
  const matrix = capabilityMatrix(caps);
  assertEquals(matrix.map((m) => m.capability), [...CAPABILITY_KEYS]);
  assertEquals(matrix.every((m) => m.available && m.detail.length > 0), true);
});

Deno.test("probeHostCapabilities drives the runner with each probe", async () => {
  const seen: string[] = [];
  const runFn: RunFn = (bin, args) => {
    seen.push([bin, ...args].join(" "));
    if (bin === "docker") return Promise.resolve(ok("29.1.3"));
    return Promise.resolve(ok());
  };
  const caps = await probeHostCapabilities(runFn);
  assertEquals(caps.kvm, true);
  assertEquals(seen.some((c) => c.startsWith("docker version")), true);
  assertEquals(seen.some((c) => c.includes("/dev/kvm")), true);
  assertEquals(
    seen.some((c) => c.startsWith("qemu-system-x86_64 -accel kvm")),
    true,
  );
  assertEquals(seen.some((c) => c.includes("/dev/net/tun")), true);
});
