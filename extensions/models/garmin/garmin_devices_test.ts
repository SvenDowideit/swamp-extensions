/**
 * Tests for `@svendowideit/garmin-devices` parsing and capability derivation.
 *
 * All pure: normalisation, product-line detection, capability unioning, override
 * precedence, and the cached-body helpers. No network, no credentials.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  asList,
  buildCapabilities,
  detectProductLines,
  familyFeatures,
  normalizeDevice,
  primaryDeviceId,
} from "./garmin_devices.ts";

// --- normalisation ----------------------------------------------------------

Deno.test("normalizeDevice reads the common field spellings", () => {
  const d = normalizeDevice({
    deviceId: 3412882339,
    displayName: "Forerunner 265",
    productSku: "010-02810-00",
    applicationKey: "FORERUNNER_265",
    softwareVersion: "18.23",
  })!;
  assertEquals(d.id, "3412882339");
  assertEquals(d.name, "Forerunner 265");
  assertEquals(d.productSku, "010-02810-00");
  // Device ids exceed Number.MAX_SAFE_INTEGER — must stay a string.
  assert(typeof d.id === "string");
});

Deno.test("normalizeDevice tolerates alternate keys and returns null without an id", () => {
  assertEquals(normalizeDevice({}), null);
  assertEquals(normalizeDevice({ deviceId: null }), null);
  const d = normalizeDevice({ id: "9", name: "Edge 1040" })!;
  assertEquals(d.id, "9");
  assertEquals(d.name, "Edge 1040");
});

// --- product lines ----------------------------------------------------------

Deno.test("detectProductLines classifies watches, cyclists and golf", () => {
  assert(detectProductLines("fenix 7x pro").includes("watch"));
  assert(detectProductLines("forerunner 265").includes("watch"));
  assert(detectProductLines("edge 1040").includes("cycling"));
  assert(detectProductLines("approach s62").includes("golf"));
  assert(detectProductLines("approach s62").includes("watch"));
  assert(detectProductLines("gpsmap 66i").includes("handheld"));
  assert(detectProductLines("index s2").includes("scale"));
  assert(detectProductLines("descent mk2").includes("dive"));
  assertEquals(detectProductLines("mystery gadget"), ["unknown"]);
});

Deno.test("detectProductLines matches short keys only as tokens", () => {
  // 'fr' must not match inside an unrelated word.
  assert(!detectProductLines("offroad xr").includes("watch"));
  // But must match an fr965.
  assert(detectProductLines("fr965").includes("watch"));
});

// --- features ---------------------------------------------------------------

Deno.test("familyFeatures adds solar/maps for the right families", () => {
  assert(familyFeatures("fenix 7").includes("solar"));
  assert(familyFeatures("epix gen 2").includes("maps"));
  assert(familyFeatures("enduro 3").includes("solar"));
  assertEquals(familyFeatures("forerunner 265").includes("solar"), false);
});

// --- capability map ---------------------------------------------------------

Deno.test("buildCapabilities unions features across devices", () => {
  const devices = [
    normalizeDevice({ deviceId: 1, displayName: "Forerunner 265" }),
    normalizeDevice({ deviceId: 2, displayName: "Edge 1040" }),
  ];
  const map = buildCapabilities(devices, null, {}, 0);
  assertEquals(map.deviceCount, 2);
  // watch features + cycling features both present
  assertEquals(map.capabilities.sleep, true);
  assertEquals(map.capabilities.hrv, true);
  assertEquals(map.capabilities.cycling, true);
  assert(map.productLines.includes("watch"));
  assert(map.productLines.includes("cycling"));
});

Deno.test("overrides win over derivation and are recorded as such", () => {
  const devices = [
    normalizeDevice({ deviceId: 1, displayName: "Forerunner 265" }),
  ];
  const map = buildCapabilities(devices, null, { hrv: false, golf: true }, 0);
  assertEquals(map.capabilities.hrv, false);
  assertEquals(map.confidence.hrv, "override");
  assertEquals(map.capabilities.golf, true);
  assertEquals(map.confidence.golf, "override");
});

Deno.test("unknown devices are surfaced, not silently ignored", () => {
  const devices = [
    normalizeDevice({ deviceId: 1, displayName: "Mystery 9000" }),
  ];
  const map = buildCapabilities(devices, null, {}, 0);
  assertEquals(map.unknownProducts, ["Mystery 9000"]);
  assertEquals(map.productLines, ["unknown"]);
});

Deno.test("user settings add menstrual/nutrition and units", () => {
  const devices = [normalizeDevice({ deviceId: 1, displayName: "fenix 7" })];
  const map = buildCapabilities(
    devices,
    {
      userData: { measurementSystem: "metric" },
      userMenstrualCycleSettings: { cycleType: "REGULAR" },
      userNutritionSettings: {},
    },
    {},
    0,
  );
  assertEquals(map.measurementSystem, "metric");
  assertEquals(map.capabilities.menstrual, true);
  assertEquals(map.capabilities.nutrition, true);
});

// --- response shaping -------------------------------------------------------

Deno.test("asList handles an array, an object wrapper, and a single object", () => {
  assertEquals(asList([{ a: 1 }]).length, 1);
  assertEquals(asList({ devices: [{ a: 1 }, { b: 2 }] }).length, 2);
  assertEquals(asList({ deviceList: [{ a: 1 }] }).length, 1);
  assertEquals(asList({ deviceId: 5 }).length, 1);
  assertEquals(asList(null).length, 0);
});

Deno.test("primaryDeviceId reads the nested and flat shapes", () => {
  assertEquals(
    primaryDeviceId({ primaryTrainingDevice: { deviceId: 99 } }),
    "99",
  );
  assertEquals(primaryDeviceId({ deviceId: 7 }), "7");
  assertEquals(primaryDeviceId({}), null);
  assertEquals(primaryDeviceId(null), null);
});
