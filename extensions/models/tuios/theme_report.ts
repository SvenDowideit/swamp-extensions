/**
 * TUIOS theme report — turn a TUIOS colour theme into a self-contained HTML
 * document that documents every colour it sets and what each one is used for.
 *
 * The report is faithful to the way TUIOS itself builds a theme's colours: the
 * `fg`/`bg`/`cursor` fields and the sixteen ANSI slots come straight from the
 * theme (falling back to the xterm defaults for any the theme omits), the
 * interface accents are derived from those slots unless the theme names a
 * `chrome` object, and the dialog ramp is either the theme's own or TUIOS's
 * constant grey ramp, derived with the same contrast maths (`internal/theme`
 * and `internal/overlay`). The colour maths below is a port of the WCAG
 * luminance, OKLab blending and contrast-floor helpers TUIOS uses, so the
 * reported ramp and ink tiers match what TUIOS draws.
 *
 * Everything here is pure — no filesystem, no network — so it can be unit
 * tested in isolation. The model method does the reading and writing.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Colour parsing and formatting
// ---------------------------------------------------------------------------

/** An opaque sRGB colour, channels 0–255. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse `#rgb` or `#rrggbb` (with or without the leading `#`) into an
 * {@link Rgb}. Returns `null` for anything else, including an alpha-carrying
 * value or trailing text, so a bad colour is never silently misread.
 */
export function parseHex(value: string): Rgb | null {
  let s = value.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  if (s.length === 3) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  if (s.length !== 6) return null;
  const n = Number.parseInt(s, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Format an {@link Rgb} as lowercase `#rrggbb`. */
export function toHex(c: Rgb): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Parse a hex colour, or return `fallback` when it does not parse. */
export function colourOr(value: string | undefined, fallback: string): string {
  if (typeof value === "string") {
    const parsed = parseHex(value);
    if (parsed) return toHex(parsed);
  }
  const fb = parseHex(fallback);
  return fb ? toHex(fb) : fallback;
}

// ---------------------------------------------------------------------------
// WCAG luminance and contrast (port of internal/overlay/contrast.go)
// ---------------------------------------------------------------------------

/** The sRGB transfer curve: decode one 0–1 channel to linear light. */
function linearize(channel: number): number {
  return channel <= 0.03928
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** The inverse sRGB transfer curve: linear light back to a 0–1 channel. */
function delinearize(channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/** WCAG 2.1 relative luminance of a colour (0 for black, 1 for white). */
export function relativeLuminance(c: Rgb): number {
  return 0.2126 * linearize(c.r / 255) +
    0.7152 * linearize(c.g / 255) +
    0.0722 * linearize(c.b / 255);
}

/**
 * The WCAG 2.1 contrast ratio between two colours: 1 for a pair that are the
 * same, 21 for black against white. This is the quantity every chrome ink is
 * held to, so the report measures rather than eyeballs legibility.
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Contrast-floor maths (port of Darker / Lighter / MixColors / Tone)
// ---------------------------------------------------------------------------

/** TUIOS's charmtone neutrals, the constant chrome ramp and its inks. */
export const CONSTANT_RAMP = {
  canvas: "#201f26",
  panel: "#2d2c36",
  surface: "#3a3943",
  card: "#4d4c57",
} as const;

/** The three ink tiers measured on the constant ramp's surface. */
export const CONSTANT_INK = {
  fg: "#fffaf1",
  fgDim: "#bfbcc8",
  fgMute: "#858392",
} as const;

const BUTTER = "#fffaf1";
const PEPPER = "#201f26";

/**
 * The colour at the luminance that measures `ratio:1` against `bg`, keeping
 * `bg`'s chromaticity. This is TUIOS's `Lighter`/`Darker` in one place: a ratio
 * above 1 lifts the colour, below 1 drops it past the ratio. Channels that run
 * off the end clamp, which is the one place the hue can drift.
 */
export function atContrast(bg: Rgb, ratio: number): Rgb {
  const target = (relativeLuminance(bg) + 0.05) / ratio - 0.05;
  return atLuminance(bg, target);
}

/** {@link atContrast} with the target clamped to [0,1] (Darker/Lighter). */
function atLuminance(bg: Rgb, targetRaw: number): Rgb {
  const target = Math.min(Math.max(targetRaw, 0), 1);
  const lr = linearize(bg.r / 255);
  const lg = linearize(bg.g / 255);
  const lb = linearize(bg.b / 255);
  const l = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  let rr: number, rg: number, rb: number;
  if (l > 0) {
    const k = target / l;
    rr = lr * k;
    rg = lg * k;
    rb = lb * k;
  } else {
    rr = rg = rb = target;
  }
  const ch = (v: number) => delinearize(Math.min(Math.max(v, 0), 1)) * 255;
  return { r: ch(rr), g: ch(rg), b: ch(rb) };
}

/** The colour one contrast step `ratio` above `bg` (TUIOS's Lighter). */
export function lighter(bg: Rgb, ratio: number): Rgb {
  return atLuminance(
    bg,
    Math.min((relativeLuminance(bg) + 0.05) * ratio - 0.05, 1),
  );
}

/** The colour that `bg` measures `ratio:1` against from above (Darker). */
export function darker(bg: Rgb, ratio: number): Rgb {
  return atLuminance(
    bg,
    Math.max((relativeLuminance(bg) + 0.05) / ratio - 0.05, 0),
  );
}

// --- OKLab blending (port of internal/overlay/oklab.go) --------------------

interface Lab {
  l: number;
  a: number;
  b: number;
}

/** Convert an sRGB colour to OKLab. */
function toLab(c: Rgb): Lab {
  const r = linearize(c.r / 255);
  const g = linearize(c.g / 255);
  const b = linearize(c.b / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

/** Convert OKLab back to sRGB, clamping an out-of-gamut channel. */
function labToRgb(c: Lab): Rgb {
  let l = c.l + 0.3963377774 * c.a + 0.2158037573 * c.b;
  let m = c.l - 0.1055613458 * c.a - 0.0638541728 * c.b;
  let s = c.l - 0.0894841775 * c.a - 1.2914855480 * c.b;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  const enc = (v: number) =>
    Math.max(
      0,
      Math.min(255, Math.round(delinearize(Math.min(Math.max(v, 0), 1)) * 255)),
    );
  return {
    r: enc(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: enc(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  };
}

/**
 * Blend `a` toward `b` by `t` (0–1) in OKLab, the perceptual space TUIOS
 * blends in, so equal steps look equal and a tint keeps its identity. Rounds
 * to the nearest 8-bit colour.
 */
export function mixColors(a: Rgb, b: Rgb, t: number): Rgb {
  if (t <= 0) return { ...a };
  if (t >= 1) return { ...b };
  const x = toLab(a);
  const y = toLab(b);
  return labToRgb({
    l: x.l + (y.l - x.l) * t,
    a: x.a + (y.a - x.a) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

// ---------------------------------------------------------------------------
// Contrast helpers used by the chrome ramp
// ---------------------------------------------------------------------------

const FLOOR = 4.5;

/** Near-white on a dark ground, near-black on a light one, by measurement. */
export function contrastText(bg: Rgb): Rgb {
  const butter = parseHex(BUTTER)!;
  const pepper = parseHex(PEPPER)!;
  return contrastRatio(butter, bg) >= contrastRatio(pepper, bg)
    ? butter
    : pepper;
}

/**
 * TUIOS's `Tone`: an ink that measures `ratio:1` on `bg`, or the ground's own
 * text end when the ground cannot reach the ratio. The hierarchy of a ramp is
 * held as ratios, so a light ground gets its tiers in dark ink.
 */
export function tone(bg: Rgb, ratio: number): Rgb {
  const ink = contrastText(bg);
  if (contrastRatio(ink, bg) <= ratio) return ink;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mixColors(bg, ink, mid), bg) >= ratio) hi = mid;
    else lo = mid;
  }
  return mixColors(bg, ink, hi);
}

/**
 * TUIOS's `ReadableAt`: return `c`, lifted toward the ground's text end until
 * it clears `floor` against `bg`, and unchanged when it already does.
 */
export function readableAt(c: Rgb, bg: Rgb, floor = FLOOR): Rgb {
  if (contrastRatio(c, bg) >= floor) return c;
  const target = contrastText(bg);
  const steps = 16;
  for (let i = 1; i < steps; i++) {
    const mixed = mixColors(c, target, i / steps);
    if (contrastRatio(mixed, bg) >= floor) return mixed;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Palette, roles and chrome
// ---------------------------------------------------------------------------

/** The sixteen ANSI slot names, in xterm order. */
export const ANSI_SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "cyan",
  "white",
  "bright_black",
  "bright_red",
  "bright_green",
  "bright_yellow",
  "bright_blue",
  "bright_purple",
  "bright_cyan",
  "bright_white",
] as const;

/** An ANSI slot name. */
export type AnsiSlot = typeof ANSI_SLOTS[number];

/** A palette key: the sixteen slots plus `fg`, `bg` and `cursor`. */
export type PaletteKey = AnsiSlot | "fg" | "bg" | "cursor";

/** xterm's default colours for the sixteen slots, used for any a theme omits. */
export const XTERM_DEFAULTS: Record<AnsiSlot, string> = {
  black: "#000000",
  red: "#cd0000",
  green: "#00cd00",
  yellow: "#cdcd00",
  blue: "#0000ee",
  purple: "#cd00cd",
  cyan: "#00cdcd",
  white: "#e5e5e5",
  bright_black: "#7f7f7f",
  bright_red: "#ff0000",
  bright_green: "#00ff00",
  bright_yellow: "#ffff00",
  bright_blue: "#5c5cff",
  bright_purple: "#ff00ff",
  bright_cyan: "#00ffff",
  bright_white: "#ffffff",
};

/**
 * What text in each colour is expected to be used for, and the TUIOS chrome
 * role a slot feeds when the theme names no `chrome` object. Grounds carry a
 * placeholder rather than a text role, because a ground is not written in.
 */
export const SLOT_ROLES: Record<string, string> = {
  fg: "default body text",
  bg: "ground behind pane text (not text itself)",
  cursor: "caret and copy cursor",
  black: "dim text, black on bright grounds",
  red: "errors, deletions, failing checks",
  green: "success, additions, ok",
  yellow: "warnings, attention",
  blue: "links, info, paths",
  purple: "keywords, syntax",
  cyan: "constants, numbers, keys",
  white: "normal text, plain output",
  bright_black: "comments, muted and secondary text",
  bright_red: "bright errors, urgent alarms",
  bright_green: "bright success, emphatic ok",
  bright_yellow: "bright warnings, current search match",
  bright_blue: "highlights, headings, selected text",
  bright_purple: "bright keywords, syntax emphasis",
  bright_cyan: "bright constants, secondary accents",
  bright_white: "brightest text, maximum emphasis",
  canvas: "chrome ramp ground (not text)",
  panel: "chrome ramp ground (not text)",
  surface: "chrome ramp ground (not text)",
  card: "chrome ramp ground (not text)",
};

/** A parsed TUIOS theme: the raw fields plus an optional `chrome` object. */
export interface ThemeInput {
  id: string;
  displayName: string;
  dark: boolean;
  palette: Record<PaletteKey, string>;
  chrome: Record<string, string>;
}

/** One reported palette colour with its role, contrast and floor. */
export interface PaletteRow {
  slot: string;
  hex: string;
  role: string;
  chrome: string;
  floor: number;
  ratio: number;
  passes: boolean;
}

/** One reported chrome accent. */
export interface AccentRow {
  role: string;
  hex: string;
  from: string;
  use: string;
}

/** One step of the chrome ramp, or one ink tier. */
export interface RampRow {
  name: string;
  hex: string;
  use: string;
}

/** The fully resolved model the HTML renderer consumes. */
export interface ThemeReportModel {
  id: string;
  displayName: string;
  dark: boolean;
  bg: string;
  fg: string;
  cursor: string;
  palette: PaletteRow[];
  accents: AccentRow[];
  ramp: RampRow[];
  ink: RampRow[];
  selection: RampRow[];
  matrix: { slot: string; hex: string; role: string }[];
  allColors: { name: string; hex: string }[];
  illegible: string[];
}

/**
 * Normalise a raw theme object into a {@link ThemeInput}: every palette key
 * resolved (xterm defaults for what the theme omits, each `bright_*` falling
 * back to its normal colour), the display name and `dark` flag defaulted, and
 * any `chrome` object validated to its string colours.
 */
export function normalizeTheme(raw: Record<string, unknown>): ThemeInput {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const normalOf = (slot: AnsiSlot): string => {
    const base = slot.replace(/^bright_/, "") as AnsiSlot;
    return colourOr(
      str(raw[slot]),
      colourOr(str(raw[base]), XTERM_DEFAULTS[base]),
    );
  };
  const palette = {} as Record<PaletteKey, string>;
  const fg = colourOr(str(raw.fg), "#e5e5e5");
  palette.fg = fg;
  palette.bg = colourOr(str(raw.bg), "#000000");
  palette.cursor = colourOr(str(raw.cursor), fg);
  for (const slot of ANSI_SLOTS) {
    palette[slot] = /^bright_/.test(slot)
      ? normalOf(slot)
      : colourOr(str(raw[slot]), XTERM_DEFAULTS[slot]);
  }
  const chrome: Record<string, string> = {};
  const rawChrome = raw.chrome;
  if (rawChrome && typeof rawChrome === "object" && !Array.isArray(rawChrome)) {
    for (const [k, v] of Object.entries(rawChrome as Record<string, unknown>)) {
      if (typeof v === "string" && parseHex(v)) chrome[k] = toHex(parseHex(v)!);
    }
  }
  return {
    id: str(raw.id) || "theme",
    displayName: str(raw.display_name) || str(raw.id) || "Theme",
    dark: raw.dark !== false,
    palette,
    chrome,
  };
}

/**
 * Build a raw theme object from the JSON `tuios list-themes <id> --json`
 * produces, for a theme that has no file (a built-in). The command reports the
 * resolved palette — `bg`, `fg`, `cursor` and one swatch per ANSI slot — but no
 * `chrome` object, which built-in themes do not carry. Returns `null` when the
 * output is not the expected shape.
 */
export function themeFromListThemes(
  json: string,
  fallbackId: string,
): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const palette = (value as { palette?: unknown } | null)?.palette;
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) {
    return null;
  }
  const pal = palette as Record<string, unknown>;
  const raw: Record<string, unknown> = {
    id: typeof pal.id === "string" ? pal.id : fallbackId,
  };
  if (typeof pal.display_name === "string") raw.display_name = pal.display_name;
  if (typeof pal.dark === "boolean") raw.dark = pal.dark;
  for (const key of ["bg", "fg", "cursor"]) {
    if (typeof pal[key] === "string") raw[key] = pal[key];
  }
  if (Array.isArray(pal.swatches)) {
    for (const swatch of pal.swatches) {
      const s = swatch as { name?: unknown; hex?: unknown };
      if (typeof s.name === "string" && typeof s.hex === "string") {
        raw[s.name] = s.hex;
      }
    }
  }
  return raw;
}

/** The resolved neutral ramp and ink tiers for a theme. */
interface ResolvedRamp {
  canvas: string;
  panel: string;
  surface: string;
  card: string;
  fg: string;
  fgDim: string;
  fgMute: string;
}

/** The constant-ramp ratios TUIOS holds a named surface to. */
function rampRatios() {
  const ch = (a: string, b: string) =>
    contrastRatio(parseHex(a)!, parseHex(b)!);
  return {
    canvas: ch(CONSTANT_RAMP.surface, CONSTANT_RAMP.canvas),
    panel: ch(CONSTANT_RAMP.surface, CONSTANT_RAMP.panel),
    card: ch(CONSTANT_RAMP.card, CONSTANT_RAMP.surface),
    fg: ch(CONSTANT_INK.fg, CONSTANT_RAMP.surface),
    fgDim: ch(CONSTANT_INK.fgDim, CONSTANT_RAMP.surface),
    fgMute: ch(CONSTANT_INK.fgMute, CONSTANT_RAMP.surface),
  };
}

/**
 * Whether dark ink reads better on `ground` than light. TUIOS rebuilds its
 * chrome ramp from the background on a light theme; this is the same verdict.
 */
export function groundIsLight(ground: Rgb): boolean {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  return contrastRatio(ground, black) > contrastRatio(ground, white);
}

/**
 * Resolve the chrome ramp: the theme's own named steps where it has them, the
 * constant ramp otherwise, and on a light theme (with no custom ramp) a ramp
 * built from the theme's background the way TUIOS does. The ink tiers are
 * derived from the surface and lifted so each reads on every step.
 */
export function resolveRamp(theme: ThemeInput): ResolvedRamp {
  const chrome = theme.chrome;
  const ratios = rampRatios();
  const hasCustom = ["canvas", "panel", "surface", "card"].some((k) =>
    chrome[k]
  );

  // The constant ramp is used verbatim (its inks are the constants), while a
  // named surface moves the ramp and re-derives the inks with it.
  const light = !hasCustom && !theme.dark &&
    groundIsLight(parseHex(theme.palette.bg)!);
  if (!hasCustom && !light) {
    return { ...CONSTANT_RAMP, ...CONSTANT_INK };
  }

  let canvas: string, panel: string, surface: string, card: string;
  if (light) {
    // A light theme's chrome is light (lightDialogChrome): the background is the
    // canvas and the surface sits one small step below it.
    canvas = theme.palette.bg;
    surface = toHex(darker(parseHex(canvas)!, 1.2));
    panel = toHex(darker(parseHex(surface)!, ratios.panel));
    card = toHex(lighter(parseHex(surface)!, ratios.card));
  } else if (chrome.surface) {
    surface = chrome.surface;
    canvas = chrome.canvas ?? toHex(darker(parseHex(surface)!, ratios.canvas));
    panel = chrome.panel ?? toHex(darker(parseHex(surface)!, ratios.panel));
    card = chrome.card ?? toHex(lighter(parseHex(surface)!, ratios.card));
  } else {
    canvas = chrome.canvas ?? CONSTANT_RAMP.canvas;
    panel = chrome.panel ?? CONSTANT_RAMP.panel;
    surface = CONSTANT_RAMP.surface;
    card = chrome.card ?? CONSTANT_RAMP.card;
  }

  const s = parseHex(surface)!;
  const grounds = [canvas, panel, surface, card].map((h) => parseHex(h)!);
  let fg = tone(s, ratios.fg);
  let fgDim = tone(s, ratios.fgDim);
  const fgMute = tone(s, ratios.fgMute);
  for (const g of grounds) {
    fg = readableAt(fg, g);
    fgDim = readableAt(fgDim, g);
  }
  return {
    canvas,
    panel,
    surface,
    card,
    fg: toHex(fg),
    fgDim: toHex(fgDim),
    fgMute: toHex(fgMute),
  };
}

/**
 * Resolve the interface accents: the theme's `chrome` values where named, the
 * ANSI slots TUIOS derives them from otherwise. `from` names where each came
 * from so the report can point a slot at the role it drives.
 */
export function resolveAccents(theme: ThemeInput): AccentRow[] {
  const p = theme.palette;
  const c = theme.chrome;
  const pick = (
    name: string,
    slot: AnsiSlot,
  ): { hex: string; from: string } => {
    const named = c[name];
    return named
      ? { hex: named, from: "chrome" }
      : { hex: p[slot], from: slot };
  };
  const accent = pick("accent", "bright_blue");
  const accentBright = pick("accent_bright", "bright_cyan");
  const success = pick("success", "bright_green");
  const warning = pick("warning", "yellow");
  const error = pick("error", "bright_red");
  const info = pick("info", "bright_blue");
  return [
    { role: "accent", ...accent, use: "logo, selected row, window-mode pill" },
    {
      role: "accent_bright",
      ...accentBright,
      use: "secondary accent, focused border (window mode)",
    },
    {
      role: "success",
      ...success,
      use: "terminal-mode pill, focused border (terminal mode), success",
    },
    { role: "warning", ...warning, use: "copy-mode pill, warnings" },
    { role: "error", ...error, use: "error messages" },
    { role: "info", ...info, use: "info messages" },
  ];
}

/**
 * Build the full report model for a theme: palette rows with roles and
 * contrasts, derived accents, the chrome ramp with ink tiers, the (theme
 * independent) selection colours, and the two swatch sets the HTML renders.
 */
export function buildReport(
  theme: ThemeInput,
  selection: RampRow[],
): ThemeReportModel {
  const p = theme.palette;
  const accents = resolveAccents(theme);
  const ramp = resolveRamp(theme);

  const floorFor = (slot: string) => (slot === "fg" ? FLOOR : 3.0);
  const bg = parseHex(p.bg)!;
  const palette: PaletteRow[] = [];
  const illegible: string[] = [];

  const addRow = (slot: string, hex: string, role: string, chrome: string) => {
    const floor = floorFor(slot);
    const ratio = contrastRatio(parseHex(hex)!, bg);
    const passes = ratio >= floor;
    if (!passes && slot !== "bg") illegible.push(slot);
    palette.push({
      slot,
      hex,
      role,
      chrome,
      floor,
      ratio,
      passes,
    });
  };

  // The TUIOS chrome roles each slot drives, for slots the theme did not
  // override. A slot can drive more than one (bright_blue is both the accent
  // and the info ink); the theme's own chrome values drop the slot from the map.
  const slotRoles = new Map<AnsiSlot, string[]>();
  for (const a of accents) {
    if (a.from === "chrome") continue;
    const slot = a.from as AnsiSlot;
    if (!(slot in p)) continue;
    slotRoles.set(slot, [...(slotRoles.get(slot) ?? []), a.role]);
  }
  const chromeFor = (slot: AnsiSlot): string =>
    (slotRoles.get(slot) ?? []).join(", ");

  for (const slot of ANSI_SLOTS) {
    addRow(slot, p[slot], SLOT_ROLES[slot] ?? "", chromeFor(slot));
  }

  const allColors = [
    { name: "fg", hex: p.fg },
    { name: "bg", hex: p.bg },
    { name: "cursor", hex: p.cursor },
    ...ANSI_SLOTS.map((s) => ({ name: s, hex: p[s] })),
    { name: "canvas", hex: ramp.canvas },
    { name: "panel", hex: ramp.panel },
    { name: "surface", hex: ramp.surface },
    { name: "card", hex: ramp.card },
  ];

  const matrix = [
    { slot: "fg", hex: p.fg, role: SLOT_ROLES.fg },
    { slot: "bg", hex: p.bg, role: SLOT_ROLES.bg },
    { slot: "cursor", hex: p.cursor, role: SLOT_ROLES.cursor },
    ...ANSI_SLOTS.map((s) => ({
      slot: s,
      hex: p[s],
      role: SLOT_ROLES[s] ?? "",
    })),
    { slot: "canvas", hex: ramp.canvas, role: SLOT_ROLES.canvas },
    { slot: "panel", hex: ramp.panel, role: SLOT_ROLES.panel },
    { slot: "surface", hex: ramp.surface, role: SLOT_ROLES.surface },
    { slot: "card", hex: ramp.card, role: SLOT_ROLES.card },
  ];

  return {
    id: theme.id,
    displayName: theme.displayName,
    dark: theme.dark,
    bg: p.bg,
    fg: p.fg,
    cursor: p.cursor,
    palette,
    accents,
    ramp: [
      {
        name: "canvas",
        hex: ramp.canvas,
        use: "darkest base of the ramp, behind overlays",
      },
      {
        name: "panel",
        hex: ramp.panel,
        use: "one step below surface, reads as raised",
      },
      {
        name: "surface",
        hex: ramp.surface,
        use: "fill of every dialog (palette, pickers, menus)",
      },
      {
        name: "card",
        hex: ramp.card,
        use: "one step above surface, reads as inset",
      },
    ],
    ink: [
      { name: "fg", hex: ramp.fg, use: "primary text on the ramp" },
      { name: "fgDim", hex: ramp.fgDim, use: "dimmed text on the ramp" },
      { name: "fgMute", hex: ramp.fgMute, use: "muted text on the ramp" },
    ],
    selection,
    matrix,
    allColors,
    illegible,
  };
}

// ---------------------------------------------------------------------------
// Selection colours from config.toml
// ---------------------------------------------------------------------------

/** The `[appearance.selection]` colours TUIOS draws over pane content. */
export const DEFAULT_SELECTION: RampRow[] = [
  { name: "selection.bg", hex: "#45475a", use: "background of selected text" },
  {
    name: "search_bg / search_fg",
    hex: "#8a6d2f",
    use: "every search match (fg #f5e7c8)",
  },
  {
    name: "match_bg / match_fg",
    hex: "#e5a93d",
    use: "the match under the cursor (fg #1c1b19)",
  },
  {
    name: "cursor_bg / cursor_fg",
    hex: "#39c5cf",
    use: "the copy-mode cursor (fg #08222b)",
  },
];

/** The setting label, config key and use for each selection row. */
const SELECTION_KEYS: { name: string; key: string; use: string }[] = [
  { name: "selection.bg", key: "bg", use: "background of selected text" },
  {
    name: "search_bg / search_fg",
    key: "search_bg",
    use: "every search match (fg #f5e7c8)",
  },
  {
    name: "match_bg / match_fg",
    key: "match_bg",
    use: "the match under the cursor (fg #1c1b19)",
  },
  {
    name: "cursor_bg / cursor_fg",
    key: "cursor_bg",
    use: "the copy-mode cursor (fg #08222b)",
  },
];

/**
 * Read the `[appearance.selection]` colours from a TUIOS `config.toml`,
 * falling back to the documented defaults for any key the file omits. Only the
 * `bg`-family keys are read; the `fg` companions are named in each row's use
 * text at their defaults, which is enough for the report's swatches.
 */
export function readSelectionColors(toml: string): RampRow[] {
  const values: Record<string, string> = {};
  let inSelection = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[([^\]]+)\]/);
    if (section) {
      inSelection = section[1] === "appearance.selection";
      continue;
    }
    if (!inSelection) continue;
    const m = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    values[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/s, "$2");
  }
  return SELECTION_KEYS.map(({ name, key, use }, i) => {
    const stored = values[key];
    const hex = stored && parseHex(stored)
      ? toHex(parseHex(stored)!)
      : DEFAULT_SELECTION[i].hex;
    return { name, hex, use };
  });
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/** Escape a string for safe inclusion in HTML text or an attribute. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the report HTML. The static shell carries a JSON payload and a small
 * script that paints every section, so the document is self-contained — no
 * network, no build step — and the swatch text picks a readable ink per tile.
 */
export function renderThemeReportHtml(model: ThemeReportModel): string {
  const data = JSON.stringify(model).replace(/</g, "\\u003c");
  const title = escapeHtml(`${model.displayName} — TUIOS theme colours`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem; background:#141414; color:#e8e8e8;
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  h2 { font-size:1.05rem; margin:2.25rem 0 .5rem; border-bottom:1px solid #333; padding-bottom:.35rem; }
  h3 { font-size:.95rem; margin:1.5rem 0 .35rem; color:#bbb; }
  p.note { color:#9a9a9a; margin:.25rem 0 1rem; max-width:75ch; }
  code { background:#262626; padding:.05rem .3rem; border-radius:3px; }
  .theme { display:flex; gap:1rem; flex-wrap:wrap; margin:1rem 0; }
  .card { background:var(--tbg); color:var(--tfg); border:1px solid #444; border-radius:6px;
          padding:1rem 1.25rem; flex:1; min-width:280px; }
  .card .lbl { font-size:.75rem; opacity:.7; text-transform:uppercase; letter-spacing:.08em; }
  table { border-collapse:collapse; width:100%; margin:.5rem 0 1rem; font-size:13px; }
  th,td { text-align:left; padding:.35rem .6rem; border-bottom:1px solid #2c2c2c; vertical-align:middle; }
  th { color:#9a9a9a; font-weight:600; font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; }
  td.hex { color:#9a9a9a; white-space:nowrap; }
  .swatch { display:inline-block; width:100%; min-width:52px; height:1.5rem; border-radius:3px;
            border:1px solid #00000055; text-align:center; line-height:1.5rem; font-weight:700; }
  .chip { display:inline-block; padding:.15rem .5rem; border-radius:4px; font-weight:700;
          border:1px solid #00000055; }
  .slot { font-weight:700; }
  .fail { color:#ff9e64; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:.6rem; margin:.5rem 0; }
  .tile { border-radius:6px; padding:.6rem; border:1px solid #00000055; }
  .tile .name { font-weight:700; font-size:.9rem; }
  .tile .h { font-size:.75rem; opacity:.85; }
  .ramp { display:flex; border-radius:6px; overflow:hidden; border:1px solid #000; margin:.5rem 0; }
  .ramp div { flex:1; padding:.85rem .5rem; text-align:center; font-size:.75rem; }
  .matrix td, .matrix th { text-align:center; font-size:.8rem; }
  .matrix td:first-child { text-align:left; white-space:nowrap; }
  .legend { color:#8a8a8a; font-size:.8rem; margin:.35rem 0 0; }
</style>
</head>
<body>
<script id="theme-data" type="application/json">${data}</script>
<h1 id="h1"></h1>
<p class="note" id="subtitle"></p>
<div id="base"></div>
<h2>1 &middot; The 16 ANSI colours</h2>
<p class="note">What programs in your panes paint with. The last column is the TUIOS chrome
role each slot feeds when the theme names no <code>chrome</code> object. Contrast is measured
against the theme background; a <span class="fail">!</span> marks a slot below its readability floor.</p>
<div id="palette"></div>
<h2>2 &middot; Chrome accents</h2>
<p class="note">The interface accents and, for each, where it comes from — a theme
<code>chrome</code> value, or the ANSI slot TUIOS derives it from.</p>
<div id="accents"></div>
<h2>3 &middot; The dialog / chrome ramp</h2>
<p class="note">Where dialogs (palette, pickers, menus, which-key) are drawn. On a dark theme
with no <code>chrome</code> ramp this is TUIOS's constant grey ramp; a named
<code>chrome.surface</code> moves it, and a light theme builds it from its background.</p>
<div id="ramp"></div>
<div id="ink"></div>
<h2>4 &middot; Selection &amp; search colours</h2>
<p class="note">The <code>[appearance.selection]</code> colours TUIOS draws over pane content —
settings rather than part of the theme.</p>
<div id="selection"></div>
<h2>5 &middot; Every colour on the backgrounds it meets</h2>
<p class="note">Each palette colour rendered as text on the surfaces it can land on. The text
is the role that colour is expected to be used for.</p>
<div id="matrix"></div>
<h2>6 &middot; All colours as backgrounds</h2>
<div id="grid" class="grid"></div>
<script>
const M = JSON.parse(document.getElementById("theme-data").textContent);
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
function lum(hex){const n=parseInt(hex.slice(1),16),r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  const f=c=>{c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);};
  return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);}
function inkOn(hex){return lum(hex)>0.35?"#000":"#fff";}
function sw(hex,label){return '<span class="swatch" style="background:'+hex+';color:'+inkOn(hex)+'">'+esc(label)+'</span>';}

document.documentElement.style.setProperty("--tbg",M.bg);
document.documentElement.style.setProperty("--tfg",M.fg);
document.getElementById("h1").textContent = M.displayName + " — TUIOS theme";
document.getElementById("subtitle").innerHTML =
  "theme id <code>"+esc(M.id)+"</code> · "+(M.dark?"dark":"light")+" · background <code>"+esc(M.bg)+"</code>. "+
  "The hex values are the theme's own; the accents and ramp are derived exactly as TUIOS builds them, "+
  (M.illegible.length? ("and "+M.illegible.length+" slot(s) fall below their floor on this background: "+esc(M.illegible.join(", "))+".") : "and every slot clears its floor on this background.");

document.getElementById("base").innerHTML =
  '<div class="theme"><div class="card"><div class="lbl">foreground / cursor</div>'+
  '<div style="font-size:1.5rem;font-weight:700">The quick brown fox 0123</div>'+
  '<div class="lbl" style="margin-top:.5rem">on background '+esc(M.bg)+'</div></div>'+
  '<div class="card" style="background:#000"><div class="lbl" style="opacity:.9">same colours on black</div>'+
  '<div style="color:'+esc(M.fg)+';font-weight:700;font-size:1.25rem">The quick brown fox 0123</div></div></div>';

let h = '<table><tr><th>Slot</th><th>Text</th><th>Background</th><th>Hex</th><th>Contrast</th><th>Chrome role</th></tr>';
for (const r of M.palette) {
  h += '<tr><td class="slot" style="color:'+esc(r.hex)+'">'+esc(r.slot)+'</td>'+
       '<td><span class="chip" style="color:'+esc(r.hex)+';background:'+esc(M.bg)+'">text</span></td>'+
       '<td>'+sw(r.hex, esc(r.hex))+'</td>'+
       '<td class="hex">'+esc(r.hex)+'</td>'+
       '<td'+(r.passes?'': ' class="fail"')+'>'+(r.passes?'':'! ')+r.ratio.toFixed(2)+':1</td>'+
       '<td>'+esc(r.chrome||"—")+'</td></tr>';
}
document.getElementById("palette").innerHTML = h + '</table>';

h = '<table><tr><th>Role</th><th>Swatch</th><th>Hex</th><th>From</th><th>What it colours</th></tr>';
for (const a of M.accents) {
  h += '<tr><td class="slot">'+esc(a.role)+'</td><td>'+sw(a.hex,esc(a.hex))+'</td>'+
       '<td class="hex">'+esc(a.hex)+'</td><td>'+esc(a.from)+'</td><td>'+esc(a.use)+'</td></tr>';
}
document.getElementById("accents").innerHTML = h + '</table>';

h = '<div class="ramp">';
for (const r of M.ramp) h += '<div style="background:'+esc(r.hex)+';color:'+inkOn(r.hex)+'">'+esc(r.name)+'<br><b>'+esc(r.hex)+'</b></div>';
h += '</div><table><tr><th>Step</th><th>Swatch</th><th>Hex</th><th>Used for</th></tr>';
for (const r of M.ramp) h += '<tr><td class="slot">'+esc(r.name)+'</td><td>'+sw(r.hex,esc(r.hex))+'</td><td class="hex">'+esc(r.hex)+'</td><td>'+esc(r.use)+'</td></tr>';
document.getElementById("ramp").innerHTML = h + '</table>';

h = '<h3>Ink tiers on the ramp</h3><table><tr><th>Tier</th><th>Preview</th><th>Hex</th><th>Used for</th></tr>';
for (const r of M.ink) h += '<tr><td class="slot">'+esc(r.name)+'</td><td style="background:'+esc(M.ramp[2].hex)+'"><span style="color:'+esc(r.hex)+'">text on surface</span></td><td class="hex">'+esc(r.hex)+'</td><td>'+esc(r.use)+'</td></tr>';
document.getElementById("ink").innerHTML = h + '</table>';

h = '<table><tr><th>Setting</th><th>Preview</th><th>Hex</th><th>Used for</th></tr>';
for (const r of M.selection) h += '<tr><td class="slot">'+esc(r.name)+'</td><td>'+sw(r.hex,"preview")+'</td><td class="hex">'+esc(r.hex)+'</td><td>'+esc(r.use)+'</td></tr>';
document.getElementById("selection").innerHTML = h + '</table>';

const grounds = [["bg",M.bg],["black","#000000"],["surface",M.ramp[2].hex],["white","#ffffff"]];
h = '<table class="matrix"><tr><th>Colour</th>'+grounds.map(g=>'<th>on '+esc(g[0])+' '+esc(g[1])+'</th>').join('')+'</tr>';
for (const r of M.matrix) {
  h += '<tr><td class="slot" style="color:'+esc(r.hex)+'">'+esc(r.slot)+' <span class="hex">'+esc(r.hex)+'</span></td>';
  for (const g of grounds) h += '<td style="background:'+esc(g[1])+';color:'+esc(r.hex)+';font-weight:700">'+esc(r.role||"—")+'</td>';
  h += '</tr>';
}
document.getElementById("matrix").innerHTML = h + '</table>';

h = '';
for (const c of M.allColors) h += '<div class="tile" style="background:'+esc(c.hex)+';color:'+inkOn(c.hex)+'"><div class="name">'+esc(c.name)+'</div><div class="h">'+esc(c.hex)+'</div></div>';
document.getElementById("grid").innerHTML = h;
</script>
</body>
</html>
`;
}
