import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { parseFitSession } from "./zwift_fit.ts";

function float32LE(value: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return [...new Uint8Array(buf)];
}

function buildSessionFit(
  np: number,
  tss: number,
  intensity: number,
  withCompressedRecord = false,
): Uint8Array {
  const definition = [
    0x40, // definition message
    0x00, // reserved
    0x00, // little-endian
    0x12,
    0x00, // global 18 (session)
    0x03, // 3 fields
    34,
    2,
    0x84, // normalized_power uint16
    35,
    4,
    0x88, // TSS float32
    36,
    4,
    0x88, // IF float32
  ];
  const data = [
    0x00, // data message header, local type 0
    np & 0xff,
    (np >> 8) & 0xff,
    ...float32LE(tss),
    ...float32LE(intensity),
  ];
  const recordDefinition = [
    0x41, // definition, local type 1
    0x00,
    0x00,
    0x14,
    0x00, // global 20 (record)
    0x02, // 2 fields
    253,
    4,
    0x86, // timestamp uint32
    7,
    2,
    0x84, // power uint16
  ];
  const compressedRecord = [0xa0, 0x2c, 0x01]; // local 1, power 300
  const payload = withCompressedRecord
    ? [...recordDefinition, ...compressedRecord, ...definition, ...data]
    : [...definition, ...data];
  const header = [
    14,
    0x10,
    0x00,
    0x00,
    payload.length & 0xff,
    (payload.length >> 8) & 0xff,
    (payload.length >> 16) & 0xff,
    (payload.length >> 24) & 0xff,
    ...".FIT".split("").map((c) => c.charCodeAt(0)),
    0,
    0,
  ];
  return new Uint8Array([...header, ...payload, 0, 0]);
}

Deno.test("parseFitSession reads NP/TSS/IF from a session message", async () => {
  const fit = buildSessionFit(250, 100, 1);
  const session = await parseFitSession(fit);
  assertNotEquals(session, null);
  assertEquals(session?.normalizedPower, 250);
  assertEquals(session?.trainingStressScore, 100);
  assertEquals(session?.intensityFactor, 1);
});

Deno.test("parseFitSession skips compressed-timestamp messages", async () => {
  const fit = buildSessionFit(250, 100, 1, true);
  const session = await parseFitSession(fit);
  assertEquals(session?.normalizedPower, 250);
});

function buildPowerFit(samples: number[]): Uint8Array {
  const definition = [
    0x40, // definition
    0x00,
    0x00,
    0x14,
    0x00, // global 20 (record)
    0x01, // 1 field
    7,
    2,
    0x84, // power uint16
  ];
  const data = samples.flatMap((power) => [
    0x00, // data message, local 0
    power & 0xff,
    (power >> 8) & 0xff,
  ]);
  const payload = [...definition, ...data];
  const header = [
    14,
    0x10,
    0x00,
    0x00,
    payload.length & 0xff,
    (payload.length >> 8) & 0xff,
    (payload.length >> 16) & 0xff,
    (payload.length >> 24) & 0xff,
    ...".FIT".split("").map((c) => c.charCodeAt(0)),
    0,
    0,
  ];
  return new Uint8Array([...header, ...payload, 0, 0]);
}

Deno.test("parseFitSession computes NP from record power samples", async () => {
  const fit = buildPowerFit(Array(60).fill(200));
  const session = await parseFitSession(fit);
  assertEquals(session?.sampleCount, 60);
  assertEquals(session?.normalizedPower, 200);
});

Deno.test("parseFitSession returns null for a non-FIT buffer", async () => {
  assertEquals(await parseFitSession(new Uint8Array([1, 2, 3])), null);
});
