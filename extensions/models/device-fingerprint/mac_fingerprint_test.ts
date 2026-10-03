import { assertEquals } from "jsr:@std/assert@1";

import {
  classifyVendor,
  normaliseMac,
  ouiPrefix,
  parseNmapPrefixes,
  parseOui,
} from "./mac_fingerprint.ts";

Deno.test("normaliseMac canonicalises separator styles", () => {
  assertEquals(normaliseMac("D8-44-89-AB-7E-32"), "d8:44:89:ab:7e:32");
  assertEquals(normaliseMac("d844.89ab.7e32"), "d8:44:89:ab:7e:32");
  assertEquals(normaliseMac("d84489ab7e32"), "d8:44:89:ab:7e:32");
  assertEquals(normaliseMac("not-a-mac"), "");
});

Deno.test("ouiPrefix returns the 24-bit prefix", () => {
  assertEquals(ouiPrefix("D8-44-89-AB-7E-32"), "d8:44:89");
});

Deno.test("parseOui reads the ieee-data oui.txt format", () => {
  const text = [
    "D8-44-89   (hex)\t\tTP-LINK CORPORATION PTE. LTD.",
    "A8-42-A1   (hex)\t\tTP-Link Corporation Limited",
    "# comment line",
  ].join("\n");
  const db = parseOui(text);
  assertEquals(db.get("D8-44-89"), "TP-LINK CORPORATION PTE. LTD.");
  assertEquals(db.get("A8-42-A1"), "TP-Link Corporation Limited");
  assertEquals(db.size, 2);
});

Deno.test("parseNmapPrefixes reads the nmap format", () => {
  const db = parseNmapPrefixes("D84489 TP-Link\n58E6C5 Espressif Inc.\n");
  assertEquals(db.get("D8-44-89"), "TP-Link");
  assertEquals(db.get("58-E6-C5"), "Espressif Inc.");
});

Deno.test("classifyVendor maps vendors to coarse classes and honours overrides", () => {
  assertEquals(classifyVendor("Espressif Inc.").deviceClass, "esphome");
  assertEquals(classifyVendor("Sipeed").deviceClass, "nanokvm");
  assertEquals(classifyVendor("Ubiquiti Inc").deviceClass, "unifi");
  assertEquals(classifyVendor("Raspberry Pi Trading").deviceClass, "sbc");
  assertEquals(classifyVendor("Acme Corp").deviceClass, "");
  assertEquals(
    classifyVendor("TP-Link", {
      "tp-link": { deviceClass: "kvm", vendor: "GL.iNet" },
    }),
    { deviceClass: "kvm", vendor: "GL.iNet" },
  );
});
