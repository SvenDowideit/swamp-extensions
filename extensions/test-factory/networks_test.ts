import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  allocateSubnet,
  intToIp,
  ipToInt,
  parseCidr,
  parseCidrs,
  poolCandidates,
  remapIp,
  subnetsOverlap,
} from "./networks.ts";

Deno.test("ipToInt/intToIp round-trip", () => {
  for (
    const ip of ["0.0.0.0", "10.213.7.10", "192.0.2.10", "255.255.255.255"]
  ) {
    assertEquals(intToIp(ipToInt(ip)), ip);
  }
});

Deno.test("parseCidr masks the network address", () => {
  assertEquals(parseCidr("192.0.2.10/24").net, ipToInt("192.0.2.0"));
  assertEquals(parseCidr("10.213.0.0/16").prefix, 16);
  assertThrows(() => parseCidr("192.0.2.0"));
  assertThrows(() => parseCidr("192.0.2.0/33"));
});

Deno.test("subnetsOverlap detects containment and disjoint ranges", () => {
  assertEquals(
    subnetsOverlap(parseCidr("192.0.2.0/24"), parseCidr("192.0.2.128/25")),
    true,
  );
  assertEquals(
    subnetsOverlap(parseCidr("192.0.2.0/24"), parseCidr("192.0.3.0/24")),
    false,
  );
  assertEquals(
    subnetsOverlap(parseCidr("10.213.0.0/16"), parseCidr("10.213.200.0/24")),
    true,
  );
});

Deno.test("parseCidrs drops malformed entries", () => {
  assertEquals(parseCidrs(["192.0.2.0/24", "nope", "10.0.0.0/8"]).length, 2);
});

Deno.test("allocateSubnet prefers a free declared subnet", () => {
  const got = allocateSubnet("192.0.2.0/24", [], []);
  assertEquals(got, "192.0.2.0/24");
});

Deno.test("allocateSubnet falls back to the pool when the declared subnet is in use", () => {
  const used = parseCidrs(["192.0.2.0/24"]);
  const got = allocateSubnet("192.0.2.0/24", used, []);
  assertEquals(got, "10.213.0.0/24");
});

Deno.test("allocateSubnet skips reserved (already-chosen) subnets", () => {
  const reserved = parseCidrs(["10.213.0.0/24"]);
  const got = allocateSubnet(
    "192.0.2.0/24",
    parseCidrs(["192.0.2.0/24"]),
    reserved,
  );
  assertEquals(got, "10.213.1.0/24");
});

Deno.test("allocateSubnet throws when the pool is exhausted", () => {
  // Every pool slot is in use *and* the preferred subnet is taken.
  const used = parseCidrs([...poolCandidates(), "192.0.2.0/24"]);
  assertThrows(() => allocateSubnet("192.0.2.0/24", used, []));
});

Deno.test("remapIp preserves the host offset onto the allocated subnet", () => {
  const from = parseCidr("192.0.2.0/24");
  const to = parseCidr("10.213.7.0/24");
  assertEquals(remapIp("192.0.2.10", from, to), "10.213.7.10");
  assertEquals(remapIp("192.0.2.11", from, to), "10.213.7.11");
});

Deno.test("poolCandidates is a /16 carved into 256 /24s", () => {
  const c = poolCandidates();
  assertEquals(c.length, 256);
  assertEquals(c[0], "10.213.0.0/24");
  assertEquals(c[255], "10.213.255.0/24");
});
