/**
 * Tests for the printer-domain parsers in `prusa.ts`. Pure: no printer, no
 * network, no mocks needed.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  compareLine,
  compareVersions,
  firmwareVerdict,
  hasSettings,
  jpegDimensions,
  latestStable,
  parseFirmwareVersion,
  parseBuildDate,
  parseM115,
  parseM503,
  parseReleases,
  parseWebcamConfig,
  sha256Hex,
  snapshotStats,
  verdictForLine,
} from "./prusa.ts";

Deno.test("parseFirmwareVersion reads the installed build the log reports", () => {
  const v = parseFirmwareVersion("Prusa-Firmware 3.2.3 based on Marlin");
  assertEquals(v.version, "3.2.3");
  assertEquals(v.name, "Prusa-Firmware 3.2.3 based on Marlin");
  assertEquals(parseFirmwareVersion("no numbers here").version, "");
  // Two-part versions are accepted (3.1 style releases).
  assertEquals(parseFirmwareVersion("Prusa-Firmware 3.1").version, "3.1");
});

Deno.test("compareVersions orders numerically, not lexically", () => {
  assertEquals(compareVersions("3.1.0", "3.2.3"), -1);
  assertEquals(compareVersions("3.10.0", "3.9.0"), 1);
  assertEquals(compareVersions("3.2.3", "3.2.3"), 0);
  assertEquals(compareVersions("3.1", "3.1.0"), 0);
});

Deno.test("parseReleases tolerates shape drift and strips a leading v", () => {
  const releases = parseReleases([
    { tag_name: "v3.13.3", prerelease: false, published_at: "2026-01-01" },
    { tag_name: "3.14.0-rc1", prerelease: true },
    { nope: true },
    null,
  ]);
  assertEquals(releases.length, 2);
  assertEquals(releases[0].tag, "3.13.3");
  assertEquals(releases[1].prerelease, true);
  assertEquals(parseReleases({ not: "an array" }), []);
});

Deno.test("latestStable ignores prereleases and picks the highest", () => {
  const releases = parseReleases([
    { tag_name: "3.13.3" },
    { tag_name: "3.9.9" },
    { tag_name: "3.14.0", prerelease: true },
  ]);
  assertEquals(latestStable(releases)?.tag, "3.13.3");
  assertEquals(latestStable([]), null);
});

Deno.test("firmwareVerdict separates 'behind' from 'ahead of the known line'", () => {
  assertEquals(firmwareVerdict("3.13.3", "3.13.3"), "current");
  assertEquals(firmwareVerdict("3.1.0", "3.13.3"), "behind");
  // The MK2S case: a 3.2.3 build is ahead of the 3.1.x line an MK2 repo lists.
  assertEquals(firmwareVerdict("3.2.3", "3.1.0"), "ahead-of-known");
  assertEquals(firmwareVerdict("", "3.1.0"), "unknown");
  assertEquals(firmwareVerdict("3.1.0", ""), "unknown");
});

Deno.test("parseM115 reads the identification fields", () => {
  const id = parseM115(
    "FIRMWARE_NAME:Prusa-Firmware 3.2.3 based on Marlin FIRMWARE_URL:https://x MACHINE_TYPE:Prusa i3 MK2S EXTRUDER_COUNT:1 UUID:00000000-0000-0000-0000-000000000000",
  );
  assertEquals(id.machineType, "Prusa");
  assertEquals(id.extruderCount, 1);
  assertEquals(id.uuid, "00000000-0000-0000-0000-000000000000");
  assertEquals(parseM115("").extruderCount, null);
});

Deno.test("parseM503 reads an EEPROM dump, ignoring other lines", () => {
  const s = parseM503([
    "echo:  M92 X100.00 Y100.00 Z400.00 E500.00",
    "echo:  M203 X200.00 Y200.00 Z12.00 E120.00",
    "echo:  M201 X1000.00 Y1000.00 Z100.00 E5000.00",
    "echo:  M204 P500.00 R1000.00 T500.00",
    "echo:  M205 B20000.00 S0.00 T0.00 J0.05",
    "echo:  M301 P22.20 I1.08 D114.00",
    "echo:  M851 Z-1.50",
    "Recv: ok",
    "FIRMWARE_NAME:something",
  ].join("\n"));
  assertEquals(s.stepsPerMm, { X: 100, Y: 100, Z: 400, E: 500 });
  assertEquals(s.maxFeedrate.Z, 12);
  assertEquals(s.maxAccel.E, 5000);
  assertEquals(s.acceleration.P, 500);
  assertEquals(s.jerk.J, 0.05);
  assertEquals(s.hotendPid.P, 22.2);
  assertEquals(s.zOffset, -1.5);
  assertEquals(hasSettings(s), true);
});

Deno.test("hasSettings is false for a log with no M503 at all", () => {
  const s = parseM503("2026-11-26 13:03:03,168 - INFO - Printer reports firmware name");
  assertEquals(hasSettings(s), false);
  assertEquals(s.zOffset, null);
});

Deno.test("jpegDimensions reads width and height from the SOF segment", () => {
  // SOI, SOF0, len=17, precision=8, height=480, width=640, then 3 components.
  const jpeg = Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x01,
    0xe0,
    0x02,
    0x80,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  assertEquals(jpegDimensions(jpeg), { width: 640, height: 480 });
  assertEquals(jpegDimensions(Uint8Array.from([0x89, 0x50])), null);
  assertEquals(jpegDimensions(new Uint8Array(0)), null);
});

Deno.test("snapshotStats flags a suspiciously small JPEG of a known size", () => {
  const header = Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x01,
    0xe0,
    0x02,
    0x80,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  // A genuinely black frame: ~0.04 bytes/pixel.
  const small = new Uint8Array(12000);
  small.set(header);
  const s1 = snapshotStats(small);
  assertEquals(s1.width, 640);
  assertEquals(s1.height, 480);
  assertEquals(s1.pixels, 307200);
  assertEquals(s1.dark, true);

  // A normal scene: ~0.14 bytes/pixel, as measured on the real camera - must
  // NOT be flagged dark.
  const normal = new Uint8Array(43000);
  normal.set(header);
  assertEquals(snapshotStats(normal).dark, false);
});

Deno.test("verdictForLine never calls an MK2S build 'behind' an MK3 line", () => {
  const releases = parseReleases([
    { tag_name: "3.13.3" },
    { tag_name: "3.13.2" },
    { tag_name: "3.1.0" },
  ]);
  // Installed 3.2.3: no 3.2.x release exists, so it is unpublished, not behind.
  assertEquals(verdictForLine("3.2.3", releases), {
    verdict: "unpublished-line",
    comparedTo: "",
  });
  // Same line, older than the newest of that line.
  assertEquals(verdictForLine("3.13.2", releases), {
    verdict: "behind",
    comparedTo: "3.13.3",
  });
  // Same line, current.
  assertEquals(verdictForLine("3.13.3", releases), {
    verdict: "current",
    comparedTo: "3.13.3",
  });
  // A 3.1.0 build is compared against 3.1.0 itself, not 3.13.3.
  assertEquals(verdictForLine("3.1.0", releases), {
    verdict: "current",
    comparedTo: "3.1.0",
  });
  assertEquals(verdictForLine("", releases).verdict, "unknown");
});

Deno.test("parseBuildDate finds a date in the firmware string, or says nothing", () => {
  assertEquals(parseBuildDate("Prusa-Firmware 3.13.3 (2024-11-28)"), "2024-11-28");
  assertEquals(parseBuildDate("Prusa-Firmware 3.2.3 2021.05.01"), "2021-05-01");
  // The string this MK2S actually reports carries no date at all.
  assertEquals(parseBuildDate("Prusa-Firmware 3.2.3 based on Marlin"), "");
  assertEquals(parseBuildDate(""), "");
});

Deno.test("compareLine reports the compared release's publish date", () => {
  const releases = parseReleases([
    { tag_name: "3.13.3", published_at: "2024-11-28T12:42:21Z" },
    { tag_name: "3.13.2", published_at: "2024-06-01T00:00:00Z" },
  ]);
  assertEquals(compareLine("3.13.2", releases), {
    verdict: "behind",
    comparedTo: "3.13.3",
    comparedToPublishedAt: "2024-11-28T12:42:21Z",
  });
  // Unpublished line: nothing to date.
  assertEquals(compareLine("3.2.3", releases), {
    verdict: "unpublished-line",
    comparedTo: "",
    comparedToPublishedAt: "",
  });
});

Deno.test("sha256Hex matches a known digest", async () => {
  const digest = await sha256Hex(new TextEncoder().encode("abc"));
  assertEquals(
    digest,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("parseWebcamConfig prefers the running command line over the config file", () => {
  const c = parseWebcamConfig({
    configText: "# camera=raspi\n#camera_usb_options=\"-r 640x480 -f 10\"\n",
    serviceShow: "Environment=WEBCAM_ARGS=-r 1280x720 -f 15",
    processArgs:
      "/usr/bin/mjpg_streamer -i input_uvc.so -r 1280x720 -f 15 -d /dev/video0",
  });
  assertEquals(c.daemon, "mjpg_streamer");
  assertEquals(c.resolution, "1280x720");
  assertEquals(c.fps, 15);
  assertEquals(c.device, "/dev/video0");
  // All-comment config files yield no settings lines - which is the truth here.
  assertEquals(c.settings, []);
});

Deno.test("parseWebcamConfig falls back to the config file and names ustreamer", () => {
  const c = parseWebcamConfig({
    configText: "camera_ustreamer_camera=raspi\ncamera_usb_options=-r 640x480 -f 5\n",
    serviceShow: "",
    processArgs: "",
  });
  assertEquals(c.daemon, "ustreamer");
  assertEquals(c.resolution, "640x480");
  assertEquals(c.fps, null);
  assertEquals(c.device, "");
  assertEquals(c.settings.length, 2);
});

