/**
 * Unit tests for the theme report module: the colour maths (WCAG contrast,
 * the OKLab/contrast-floor ramp helpers), palette normalisation and chrome
 * derivation, the list-themes fallback parser, and the HTML renderer. All pure
 * — no filesystem or network.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildReport,
  colourOr,
  CONSTANT_INK,
  CONSTANT_RAMP,
  contrastRatio,
  darker,
  lighter,
  normalizeTheme,
  parseHex,
  readSelectionColors,
  renderThemeReportHtml,
  resolveRamp,
  themeFromListThemes,
  toHex,
} from "./theme_report.ts";

const BORLAND = {
  id: "borland_modern_blue",
  display_name: "Borland Modern Blue",
  dark: true,
  fg: "#ffff57",
  bg: "#003078",
  cursor: "#ffff57",
  black: "#000000",
  red: "#ff5757",
  green: "#308800",
  yellow: "#a8a800",
  blue: "#1e90ff",
  purple: "#a800a8",
  cyan: "#00a8a8",
  white: "#a8a8a8",
  bright_black: "#575757",
  bright_red: "#ff8c00",
  bright_green: "#57ff57",
  bright_yellow: "#ffff57",
  bright_blue: "#5757ff",
  bright_purple: "#ff57ff",
  bright_cyan: "#57ffff",
  bright_white: "#ffffff",
};

const SWAMP = {
  id: "swamp_club",
  display_name: "Swamp Club",
  dark: true,
  fg: "#d1d5db",
  bg: "#080808",
  black: "#5b6472",
  red: "#ff003c",
  green: "#39ff14",
  yellow: "#fbbf24",
  blue: "#22d3ee",
  purple: "#a78bfa",
  cyan: "#00d2ef",
  white: "#d1d5db",
  bright_black: "#6a7282",
  bright_red: "#fb2c36",
  bright_green: "#7dff4d",
  bright_yellow: "#fde047",
  bright_blue: "#00e5ff",
  bright_purple: "#e879f9",
  bright_cyan: "#67e8f9",
  bright_white: "#ffffff",
  chrome: {
    accent: "#39ff14",
    accent_bright: "#22d3ee",
    success: "#05df72",
    warning: "#fbbf24",
    error: "#ff003c",
    info: "#22d3ee",
    surface: "#161616",
  },
};

// ---------------------------------------------------------------------------
// Colour parsing
// ---------------------------------------------------------------------------

Deno.test("parseHex expands #rgb and rejects junk", () => {
  assertEquals(parseHex("#f0a"), { r: 255, g: 0, b: 170 });
  assertEquals(parseHex("003078"), { r: 0, g: 48, b: 120 });
  assertEquals(parseHex("#12345"), null);
  assertEquals(parseHex("nope"), null);
  assertEquals(parseHex("#gggggg"), null);
});

Deno.test("toHex round-trips through parseHex", () => {
  assertEquals(toHex({ r: 87, g: 87, b: 255 }), "#5757ff");
});

Deno.test("colourOr falls back when the value is not a colour", () => {
  assertEquals(colourOr("#ABCDEF", "#000000"), "#abcdef");
  assertEquals(colourOr(undefined, "#000000"), "#000000");
  assertEquals(colourOr("not a colour", "#000000"), "#000000");
});

// ---------------------------------------------------------------------------
// Contrast maths
// ---------------------------------------------------------------------------

Deno.test("contrastRatio matches the WCAG endpoints", () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  assertEquals(contrastRatio(black, black), 1);
  assertEquals(Math.round(contrastRatio(black, white) * 100) / 100, 21);
});

Deno.test("darker and lighter step away from the ground", () => {
  const surface = parseHex(CONSTANT_RAMP.surface)!;
  const panel = darker(surface, 1.2);
  const card = lighter(surface, 1.2);
  assertEquals(contrastRatio(panel, surface) > 1.1, true);
  assertEquals(contrastRatio(card, surface) > 1.1, true);
});

// ---------------------------------------------------------------------------
// Palette normalisation
// ---------------------------------------------------------------------------

Deno.test("normalizeTheme fills xterm defaults and bright fallbacks", () => {
  const t = normalizeTheme({ id: "bare" });
  assertEquals(t.palette.fg, "#e5e5e5");
  assertEquals(t.palette.bg, "#000000");
  assertEquals(t.palette.cursor, "#e5e5e5");
  assertEquals(t.palette.red, "#cd0000");
  // no bright_green given: it falls back to the normal green
  assertEquals(t.palette.bright_green, "#00cd00");
});

Deno.test("normalizeTheme keeps the theme's own colours", () => {
  const t = normalizeTheme(BORLAND);
  assertEquals(t.displayName, "Borland Modern Blue");
  assertEquals(t.palette.bright_blue, "#5757ff");
  assertEquals(t.dark, true);
});

// ---------------------------------------------------------------------------
// Chrome derivation
// ---------------------------------------------------------------------------

Deno.test("borland derives accents from ANSI slots and uses the constant ramp", () => {
  const report = buildReport(normalizeTheme(BORLAND), readSelectionColors(""));
  const byRole = Object.fromEntries(report.accents.map((a) => [a.role, a]));
  assertEquals(byRole.accent.hex, "#5757ff");
  assertEquals(byRole.accent.from, "bright_blue");
  assertEquals(byRole.accent_bright.hex, "#57ffff");
  assertEquals(byRole.success.hex, "#57ff57");
  assertEquals(byRole.warning.hex, "#a8a800");
  assertEquals(byRole.error.hex, "#ff8c00");
  // info follows bright_blue in TUIOS, not the plain blue slot
  assertEquals(byRole.info.hex, "#5757ff");
  assertEquals(report.ramp.map((r) => r.hex), [
    CONSTANT_RAMP.canvas,
    CONSTANT_RAMP.panel,
    CONSTANT_RAMP.surface,
    CONSTANT_RAMP.card,
  ]);
  assertEquals(report.ink.map((i) => i.hex), [
    CONSTANT_INK.fg,
    CONSTANT_INK.fgDim,
    CONSTANT_INK.fgMute,
  ]);
});

Deno.test("borland flags the slots below their floor", () => {
  const report = buildReport(normalizeTheme(BORLAND), readSelectionColors(""));
  for (const slot of ["black", "green", "purple"]) {
    assertEquals(report.illegible.includes(slot), true, `${slot} should fail`);
  }
  // red, bright_red and blue were lifted to clear their floor on the blue background
  assertEquals(report.illegible.includes("red"), false);
  assertEquals(report.illegible.includes("bright_red"), false);
  assertEquals(report.illegible.includes("blue"), false);
  assertEquals(report.illegible.includes("yellow"), false);
  assertEquals(report.illegible.includes("bright_cyan"), false);
});

Deno.test("a slot that drives a chrome role names it in the palette row", () => {
  const report = buildReport(normalizeTheme(BORLAND), readSelectionColors(""));
  const brightBlue = report.palette.find((p) => p.slot === "bright_blue");
  assertStringIncludes(brightBlue!.chrome, "accent");
  const brightCyan = report.palette.find((p) => p.slot === "bright_cyan");
  assertStringIncludes(brightCyan!.chrome, "accent_bright");
});

Deno.test("every palette colour carries a role (grounds get a placeholder)", () => {
  const report = buildReport(normalizeTheme(BORLAND), readSelectionColors(""));
  for (const row of report.matrix) {
    assertEquals(row.role.length > 0, true, `${row.slot} has no role`);
  }
  const surface = report.matrix.find((m) => m.slot === "surface");
  assertStringIncludes(surface!.role, "not text");
});

Deno.test("swamp_club takes its accents and surface from the chrome block", () => {
  const report = buildReport(normalizeTheme(SWAMP), readSelectionColors(""));
  const byRole = Object.fromEntries(report.accents.map((a) => [a.role, a]));
  assertEquals(byRole.accent.hex, "#39ff14");
  assertEquals(byRole.accent.from, "chrome");
  assertEquals(byRole.error.hex, "#ff003c");
  // a named surface moves the ramp; canvas/panel/card are derived from it
  const ramp = Object.fromEntries(report.ramp.map((r) => [r.name, r.hex]));
  assertEquals(ramp.surface, "#161616");
  assertEquals(ramp.canvas !== CONSTANT_RAMP.canvas, true);
});

Deno.test("resolveRamp keeps the constant ramp for a dark theme with no chrome", () => {
  const ramp = resolveRamp(normalizeTheme(BORLAND));
  assertEquals(ramp.surface, CONSTANT_RAMP.surface);
  assertEquals(ramp.fg, CONSTANT_INK.fg);
  assertEquals(ramp.fgMute, CONSTANT_INK.fgMute);
});

// ---------------------------------------------------------------------------
// list-themes fallback and selection colours
// ---------------------------------------------------------------------------

Deno.test("themeFromListThemes reads the palette the binary reports", () => {
  const json = JSON.stringify({
    palette: {
      id: "dracula",
      display_name: "Dracula",
      dark: true,
      bg: "#282a36",
      fg: "#f8f8f2",
      cursor: "#f8f8f2",
      swatches: [
        { name: "black", hex: "#21222c" },
        { name: "red", hex: "#ff5555" },
      ],
    },
  });
  const raw = themeFromListThemes(json, "fallback")!;
  assertEquals(raw.id, "dracula");
  assertEquals(raw.bg, "#282a36");
  assertEquals(raw.red, "#ff5555");
  const t = normalizeTheme(raw);
  assertEquals(t.palette.red, "#ff5555");
  assertEquals(t.palette.cursor, "#f8f8f2");
});

Deno.test("themeFromListThemes returns null for junk", () => {
  assertEquals(themeFromListThemes("not json", "x"), null);
  assertEquals(themeFromListThemes("{}", "x"), null);
});

Deno.test("readSelectionColors reads config values, else the defaults", () => {
  const toml = [
    "[appearance.selection]",
    "bg = '#101010'",
    "search_bg = '#8A6D2F'",
  ].join("\n");
  const rows = readSelectionColors(toml);
  assertEquals(rows[0].hex, "#101010");
  assertEquals(rows[1].hex, "#8a6d2f");
  // match_bg not set: falls back to the documented default
  assertEquals(rows[2].hex, "#e5a93d");
});

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

Deno.test("renderThemeReportHtml emits a self-contained document with the roles", () => {
  const report = buildReport(normalizeTheme(BORLAND), readSelectionColors(""));
  const html = renderThemeReportHtml(report);
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "application/json");
  // the matrix cell text is the role, not a placeholder
  assertStringIncludes(html, "errors, deletions, failing checks");
  assertStringIncludes(html, "brightest text, maximum emphasis");
  // the theme's colours are embedded
  assertStringIncludes(html, "#5757ff");
  assertStringIncludes(html, "#201f26");
});
