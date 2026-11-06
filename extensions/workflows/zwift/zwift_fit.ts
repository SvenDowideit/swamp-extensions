/**
 * Minimal FIT reader for the coach.
 *
 * Zwift's FIT files do not reliably put `normalized_power` in the session
 * message, so this reader also collects the per-record power samples and
 * computes NP from them (30 s rolling average, fourth-power mean). It handles
 * normal and compressed-timestamp data messages; session messages are usually
 * uncompressed, record messages often are compressed.
 *
 * @module
 */

import { Buffer } from "node:buffer";
import FitParser from "npm:fit-file-parser@6.2.7";

/** Session summary extracted from a FIT file. */
export interface FitSession {
  /** Normalised power, from the session message or computed from records. */
  normalizedPower: number | null;
  /** Session TSS when the file carries it (often does not). */
  trainingStressScore: number | null;
  /** Session intensity factor when present. */
  intensityFactor: number | null;
  /** Mean of the record power samples, when present. */
  averagePower: number | null;
  /** Mean of the record cadence samples, when present. */
  averageCadence: number | null;
  /** Highest cadence sample in the file, when present. */
  maxCadence: number | null;
  /** Average cadence in the best 5 s power window. */
  cadenceAt5s: number | null;
  /** Average cadence in the best 60 s power window. */
  cadenceAt60s: number | null;
  /** Number of record power samples read. */
  sampleCount: number;
}

const SESSION_MESSAGE = 18;
const RECORD_MESSAGE = 20;
const FIELD_TIMESTAMP = 253;
const FIELD_POWER = 7;
const FIELD_NORMALIZED_POWER = 34;

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

interface MessageDef {
  global: number;
  fields: FieldDef[];
  little: boolean;
}

function readUint16(
  bytes: Uint8Array,
  offset: number,
  little: boolean,
): number {
  return little
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function readFloat32(
  bytes: Uint8Array,
  offset: number,
  little: boolean,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getFloat32(0, little);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Highest finite cadence sample. */
export function maxCadenceFromSamples(
  samples: (number | null)[],
): number | null {
  const values = samples.filter((n): n is number => n !== null && n > 0);
  return values.length === 0 ? null : Math.max(...values);
}

/**
 * Average cadence in the best rolling `seconds` power window. Returns null
 * when the file is shorter than the window or has no cadence samples.
 */
export function bestWindowCadence(
  samples: { power: number | null; cadence: number | null }[],
  seconds: number,
): number | null {
  if (samples.length < seconds || seconds <= 0) return null;
  let bestPower = -1;
  let bestStart = -1;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i].power ?? 0;
    if (i >= seconds) sum -= samples[i - seconds].power ?? 0;
    if (i >= seconds - 1) {
      const avg = sum / seconds;
      if (avg > bestPower) {
        bestPower = avg;
        bestStart = i - seconds + 1;
      }
    }
  }
  if (bestStart < 0) return null;
  const cadences = samples
    .slice(bestStart, bestStart + seconds)
    .map((s) => s.cadence)
    .filter((n): n is number => n !== null && n > 0);
  return cadences.length === 0 ? null : Math.round(mean(cadences) * 10) / 10;
}

/**
 * Normalised power from per-record power samples.
 *
 * Uses a 30-sample rolling average and the fourth-power mean. FIT records are
 * normally one sample per second; for a different interval this is an
 * approximation, which is acceptable for load tracking.
 */
export function normalizedPowerFromSamples(samples: number[]): number | null {
  if (samples.length === 0) return null;
  if (samples.length < 30) {
    return Math.round(mean(samples) * 10) / 10;
  }
  const rolling: number[] = [];
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i];
    if (i >= 30) sum -= samples[i - 30];
    if (i >= 29) rolling.push(sum / 30);
  }
  const fourth = rolling.reduce((acc, value) => acc + value ** 4, 0) /
    rolling.length;
  return Math.round(Math.pow(fourth, 0.25) * 10) / 10;
}

interface ReadResult {
  offset: number;
  values: Map<number, number>;
  power: number | null;
}

/** Read one data message's fields and advance the offset. */
function readFields(
  def: MessageDef,
  bytes: Uint8Array,
  start: number,
  end: number,
  skipTimestamp: boolean,
): ReadResult | null {
  let offset = start;
  const values = new Map<number, number>();
  let power: number | null = null;
  for (const field of def.fields) {
    if (skipTimestamp && field.num === FIELD_TIMESTAMP) continue;
    if (offset + field.size > end) return null;
    if (
      def.global === RECORD_MESSAGE && field.num === FIELD_POWER &&
      field.size >= 2
    ) {
      power = readUint16(bytes, offset, def.little);
    }
    if (def.global === SESSION_MESSAGE) {
      if (field.num === FIELD_NORMALIZED_POWER && field.size >= 2) {
        values.set(field.num, readUint16(bytes, offset, def.little));
      } else if (field.baseType === 0x88 && field.size >= 4) {
        values.set(field.num, readFloat32(bytes, offset, def.little));
      }
    }
    offset += field.size;
  }
  return { offset, values, power };
}

/**
 * Parse a FIT buffer with the full parser (it handles compressed timestamps,
 * developer fields and chained files), then compute NP from the record power
 * samples when the session does not carry it.
 */
export async function parseFitSession(
  bytes: Uint8Array,
): Promise<FitSession | null> {
  try {
    const parser = new FitParser({
      force: true,
      speedUnit: "m/s",
      lengthUnit: "m",
      temperatureUnit: "celsius",
    });
    const data = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        parser.parse(Buffer.from(bytes), (error: unknown, parsed: unknown) => {
          if (error) reject(error);
          else resolve(parsed as Record<string, unknown>);
        });
      },
    );
    const records = Array.isArray(data.records)
      ? data.records as Record<string, unknown>[]
      : [];
    const windowSamples = records.map((r) => {
      const power = Number(r.power);
      const cadence = Number(r.cadence);
      return {
        power: Number.isFinite(power) ? power : null,
        cadence: Number.isFinite(cadence) ? cadence : null,
      };
    });
    const samples = windowSamples
      .map((r) => r.power)
      .filter((n): n is number => n !== null);
    const cadenceSamples = windowSamples.map((r) => r.cadence);
    const sessions = Array.isArray(data.sessions)
      ? data.sessions as Record<string, unknown>[]
      : [];
    const session = sessions[0] ?? null;
    if (!session && samples.length === 0) {
      return parseFitSessionMinimal(bytes);
    }
    const computed = normalizedPowerFromSamples(samples);
    const minimal = parseFitSessionMinimal(bytes);
    const sessionNp = session ? Number(session.normalized_power) : null;
    return {
      normalizedPower: (sessionNp && sessionNp > 0 ? sessionNp : computed) ??
        minimal?.normalizedPower ?? null,
      trainingStressScore:
        (session ? Number(session.training_stress_score) || null : null) ??
          minimal?.trainingStressScore ?? null,
      intensityFactor:
        (session ? Number(session.intensity_factor) || null : null) ??
          minimal?.intensityFactor ?? null,
      averagePower: session
        ? Number(session.avg_power) ||
          (computed ?? minimal?.averagePower ?? null)
        : computed ?? minimal?.averagePower ?? null,
      averageCadence: cadenceSamples.some((n) => n !== null)
        ? Math.round(
          mean(cadenceSamples.filter((n): n is number => n !== null)) * 10,
        ) / 10
        : null,
      maxCadence: maxCadenceFromSamples(cadenceSamples),
      cadenceAt5s: bestWindowCadence(windowSamples, 5),
      cadenceAt60s: bestWindowCadence(windowSamples, 60),
      sampleCount: samples.length || minimal?.sampleCount || 0,
    };
  } catch {
    return parseFitSessionMinimal(bytes);
  }
}

/**
 * Minimal fallback reader for hand-built FIT fixtures and unusual files.
 * Returns null when the buffer is not a FIT file or has no session/records.
 */
export function parseFitSessionMinimal(bytes: Uint8Array): FitSession | null {
  if (bytes.length < 14) return null;
  if (String.fromCharCode(...bytes.slice(8, 12)) !== ".FIT") return null;
  const headerSize = bytes[0];
  if (headerSize !== 12 && headerSize !== 14) return null;
  let offset = headerSize;
  const dataSize = new DataView(
    bytes.buffer,
    bytes.byteOffset + 4,
    4,
  ).getUint32(0, true);
  const end = Math.min(bytes.length, headerSize + dataSize);
  const defs = new Map<number, MessageDef>();
  const powerSamples: number[] = [];
  let session: Map<number, number> | null = null;

  while (offset < end) {
    if (offset >= end) break;
    const header = bytes[offset++];
    if ((header & 0x80) !== 0) {
      // Compressed timestamp: local type in bits 5-6; timestamp is omitted
      // from the payload.
      const local = (header >> 5) & 0x03;
      const def = defs.get(local);
      if (!def) break;
      const result = readFields(def, bytes, offset, end, true);
      if (!result) break;
      offset = result.offset;
      if (result.power !== null) powerSamples.push(result.power);
      continue;
    }
    if ((header & 0x40) !== 0) {
      if (offset + 5 > end) break;
      const local = header & 0x0f;
      offset++; // reserved
      const little = bytes[offset++] === 0;
      const global = readUint16(bytes, offset, little);
      offset += 2;
      const rawCount = bytes[offset++];
      const fieldCount = rawCount & 0x7f;
      const devCount = (rawCount & 0x80) !== 0
        ? (offset < end ? bytes[offset++] : 0)
        : 0;
      const fields: FieldDef[] = [];
      for (let i = 0; i < fieldCount; i++) {
        if (offset + 3 > end) return null;
        fields.push({
          num: bytes[offset],
          size: bytes[offset + 1],
          baseType: bytes[offset + 2],
        });
        offset += 3;
      }
      offset += devCount * 3;
      defs.set(local, { global, fields, little });
      continue;
    }

    const local = header & 0x0f;
    const def = defs.get(local);
    if (!def) break;
    const result = readFields(def, bytes, offset, end, false);
    if (!result) break;
    offset = result.offset;
    if (result.power !== null) powerSamples.push(result.power);
    if (def.global === SESSION_MESSAGE) session = result.values;
  }

  const sessionNp = session?.get(FIELD_NORMALIZED_POWER) ?? null;
  const computedNp = normalizedPowerFromSamples(powerSamples);
  if (session === null && powerSamples.length === 0) return null;
  return {
    normalizedPower: sessionNp && sessionNp > 0 ? sessionNp : computedNp,
    trainingStressScore: session?.get(35) ?? null,
    intensityFactor: session?.get(36) ?? null,
    averagePower: powerSamples.length > 0
      ? Math.round(mean(powerSamples) * 10) / 10
      : null,
    averageCadence: null,
    maxCadence: null,
    cadenceAt5s: null,
    cadenceAt60s: null,
    sampleCount: powerSamples.length,
  };
}
