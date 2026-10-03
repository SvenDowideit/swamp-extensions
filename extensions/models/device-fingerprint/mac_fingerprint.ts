/**
 * @svendowideit/device-fingerprint — MAC/OUI model.
 *
 * Resolve a MAC address to its registered vendor (OUI) and a coarse, generic
 * device class, using the system's IEEE OUI database. This identifies a device
 * even when it is offline or answers nothing — the MAC is usually visible in
 * ARP/DHCP — so it complements the HTTP/TLS and mDNS sources.
 *
 * MAC/OUI does NOT prove identity (virtualised MACs, randomised Wi-Fi MACs, and
 * USB Ethernet adapters move between hosts), so the vendor is a hint, not a key.
 *
 * Pure helpers (MAC normalisation, OUI-line parsing, vendor→class) are exported
 * for unit testing.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  ouiFile: z.string().default("/usr/share/ieee-data/oui.txt").describe(
    "Path to the IEEE OUI database (Debian: ieee-data package; also tries /usr/share/nmap/nmap-mac-prefixes)",
  ),
  deviceClasses: z.record(
    z.string(),
    z.object({ deviceClass: z.string(), vendor: z.string() }),
  ).default({}).describe(
    'Extend/override vendor→device-class rules, e.g. {"TP-Link": {"deviceClass":"kvm","vendor":"GL.iNet"}}; keys are matched case-insensitively as a substring of the OUI vendor name',
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const LookupArgsSchema = z.object({
  macs: z.array(z.string()).min(1).describe(
    "MAC addresses to resolve (e.g. from the fleet inventory, ARP, or a DHCP lease list)",
  ),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const MacResultSchema = z.object({
  mac: z.string(),
  oui: z.string(),
  vendor: z.string(),
  deviceClass: z.string(),
});

const MacLookupSchema = z.object({
  results: z.array(MacResultSchema),
  total: z.number(),
  vendors: z.record(z.string(), z.number()),
  resolvedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A MAC address resolved to its OUI vendor. */
export interface MacResult {
  /** Normalised MAC (lowercase, colon-separated). */
  mac: string;
  /** Its 24-bit OUI prefix (e.g. `d8:44:89`) or "". */
  oui: string;
  /** Registered vendor name from the OUI database, or "". */
  vendor: string;
  /** Coarse generic device class inferred from the vendor, or "". */
  deviceClass: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Normalise a MAC address to lowercase colon-separated form. Accepts `-`, `.`,
 * `:`, or no separators (e.g. `D8-44-89-AB-7E-32`, `d844.89ab.7e32`, `d84489ab7e32`).
 * Returns "" if it is not 12 hex digits.
 */
export function normaliseMac(mac: string): string {
  const hex = (mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return "";
  return hex.match(/.{2}/g)!.join(":");
}

/** The 24-bit OUI prefix of a normalised MAC (e.g. `d8:44:89`), or "". */
export function ouiPrefix(mac: string): string {
  const n = normaliseMac(mac);
  return n ? n.split(":").slice(0, 3).join(":") : "";
}

/** The IEEE `oui.txt` key form (`D8-44-89`) for a normalised MAC prefix. */
export function ouiKey(mac: string): string {
  return ouiPrefix(mac).toUpperCase().replace(/:/g, "-");
}

/**
 * Parse an IEEE `oui.txt` database into a map of UPPERCASE-OUI (`D8-44-89`) to
 * vendor name. Lines look like: `D8-44-89   (hex)\t\tVENDOR NAME`.
 */
export function parseOui(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(
      /^([0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2})\s+\(hex\)\s+(.+)$/,
    );
    if (m) map.set(m[1].toUpperCase(), m[2].trim());
  }
  return map;
}

/** Parse nmap's `nmap-mac-prefixes` format (`D84489 Vendor Name`). */
export function parseNmapPrefixes(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^([0-9A-Fa-f]{6})\s+(.+)$/);
    if (m) {
      map.set(
        `${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`
          .toUpperCase(),
        m[2].trim(),
      );
    }
  }
  return map;
}

/**
 * Classify a vendor string into a coarse, generic device class. Deliberately a
 * small public table; site-specific overrides come from the `deviceClasses`
 * global arg (substring match on the vendor, case-insensitive).
 */
export function classifyVendor(
  vendor: string,
  overrides: Record<string, { deviceClass: string; vendor: string }> = {},
): { deviceClass: string; vendor: string } {
  const v = (vendor || "").toLowerCase();
  for (const [key, val] of Object.entries(overrides)) {
    if (v.includes(key.toLowerCase())) return val;
  }
  if (!v) return { deviceClass: "", vendor: "" };
  if (v.includes("espressif")) return { deviceClass: "esphome", vendor };
  if (v.includes("shelly") || v.includes("allterco")) {
    return { deviceClass: "shelly", vendor };
  }
  if (v.includes("raspberry pi")) return { deviceClass: "sbc", vendor };
  if (v.includes("sipeed")) return { deviceClass: "nanokvm", vendor };
  if (v.includes("ubiquiti")) return { deviceClass: "unifi", vendor };
  if (v.includes("tp-link")) return { deviceClass: "network-device", vendor };
  if (v.includes("google")) return { deviceClass: "google", vendor };
  if (v.includes("apple")) return { deviceClass: "apple", vendor };
  if (v.includes("amazon")) return { deviceClass: "amazon", vendor };
  if (
    v.includes("intel") || v.includes("dell") || v.includes("lenovo") ||
    v.includes("asustek") || v.includes("micro-star")
  ) {
    return { deviceClass: "computer", vendor };
  }
  return { deviceClass: "", vendor };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for the MAC/OUI fingerprint model. */
export const model = {
  type: "@svendowideit/device-fingerprint/mac",
  version: "2026.10.03.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "oui-database": {
      description: "Ensure an OUI database is present",
      labels: ["config"],
      appliesTo: ["lookup"],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const candidates = [
          context.globalArgs.ouiFile,
          "/usr/share/ieee-data/oui.txt",
          "/usr/share/nmap/nmap-mac-prefixes",
          "/var/lib/ieee-data/oui.txt",
        ];
        // Synchronous existence check is fine here; the check is advisory.
        for (const c of candidates) {
          try {
            Deno.statSync(c);
            return { pass: true };
          } catch {
            // try next
          }
        }
        return {
          pass: false,
          errors: [
            "no OUI database found (install the `ieee-data` package, or point ouiFile at one)",
          ],
        };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.03.1",
      description:
        "Initial release: resolve MAC addresses to their OUI vendor and a coarse generic device class, using the system IEEE OUI database (or nmap-mac-prefixes), with caller overrides. Complements the HTTP/TLS and mDNS fingerprinting sources.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    lookup: {
      description: "MAC addresses resolved to vendors and device classes",
      schema: MacLookupSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    lookup: {
      description: "Resolve MAC addresses to their OUI vendor and device class",
      arguments: LookupArgsSchema,
      execute: async (
        args: z.infer<typeof LookupArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const db = await loadOui(g.ouiFile);
        const results: MacResult[] = args.macs.map((mac) => {
          const normalised = normaliseMac(mac);
          const oui = ouiPrefix(mac);
          const vendor = oui ? (db.get(ouiKey(mac)) ?? "") : "";
          const { deviceClass, vendor: canonVendor } = classifyVendor(
            vendor,
            g.deviceClasses,
          );
          return {
            mac: normalised,
            oui,
            vendor: canonVendor,
            deviceClass,
          };
        });
        const vendors: Record<string, number> = {};
        for (const r of results) {
          const key = r.vendor || "(unknown)";
          vendors[key] = (vendors[key] ?? 0) + 1;
        }
        const resolved = results.filter((r) => r.vendor).length;
        context.logger?.info("Resolved {resolved}/{total} MAC(s) to a vendor", {
          resolved,
          total: results.length,
        });
        const handle = await context.writeResource("lookup", "current", {
          results,
          total: results.length,
          vendors,
          resolvedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Load the OUI database, trying the configured path then common locations. */
async function loadOui(configured: string): Promise<Map<string, string>> {
  const candidates = [
    configured,
    "/usr/share/ieee-data/oui.txt",
    "/var/lib/ieee-data/oui.txt",
  ];
  for (const path of candidates) {
    try {
      const text = await Deno.readTextFile(path);
      return parseOui(text);
    } catch {
      // try next
    }
  }
  // Fall back to nmap's prefix file (different format).
  for (
    const path of [
      "/usr/share/nmap/nmap-mac-prefixes",
      "/etc/nmap-mac-prefixes",
    ]
  ) {
    try {
      const text = await Deno.readTextFile(path);
      return parseNmapPrefixes(text);
    } catch {
      // try next
    }
  }
  return new Map();
}
