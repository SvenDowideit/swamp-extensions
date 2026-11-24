// Managed by @svendowideit/swamp-ide-pi-plugin. Do not edit this installed
// copy by hand; change the bundled source and reinstall with
// `swamp model @svendowideit/swamp-ide-pi-plugin method run install`.
//
/** Cross-process, abortable approval lock.
 *
 * The lock is created with O_EXCL, so a second process cannot enter. The
 * payload is written through the open handle, avoiding the zero-byte window
 * that used to make an unparsable lock permanent. Staleness is checked from
 * the file's mtime before any parse, so a corrupt lock is still recoverable.
 */
import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export interface ApprovalLock {
  path: string;
  token: string;
  /** Refresh the mtime only while this token still owns the file. */
  heartbeat: () => Promise<boolean>;
  /** Remove the file only while this token still owns it. */
  release: () => Promise<boolean>;
}

export interface AcquireApprovalLockOptions {
  path: string;
  signal?: AbortSignal;
  /** Maximum time to wait for a live holder; null means unavailable. */
  waitMs?: number;
  /** A lock older than this is treated as abandoned. */
  staleMs?: number;
  pollMs?: number;
  now?: () => number;
  token?: string;
  pid?: number;
}

interface LockPayload {
  token?: string;
  pid?: number;
  at?: number;
}

function parsePayload(text: string): LockPayload | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function randomToken(): string {
  return randomBytes(8).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquire the single approval lock, or return null on abort/timeout. */
export async function acquireApprovalLock(
  options: AcquireApprovalLockOptions,
): Promise<ApprovalLock | null> {
  const path = options.path;
  const waitMs = options.waitMs ?? 30_000;
  const staleMs = options.staleMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? Date.now;
  const token = options.token ?? randomToken();
  const pid = options.pid ?? process.pid;
  const startedAt = now();

  await mkdir(dirname(path), { recursive: true });

  const payload = () => JSON.stringify({ token, pid, at: now() });

  for (;;) {
    if (options.signal?.aborted) return null;

    let handle: FileHandle | undefined;
    let created = false;
    try {
      handle = await open(path, "wx");
      created = true;
      await handle.writeFile(payload(), "utf8");
      await handle.close();
      handle = undefined;
      return {
        path,
        token,
        heartbeat: async () => {
          let current: LockPayload | null;
          try {
            current = parsePayload(await readFile(path, "utf8"));
          } catch {
            return false;
          }
          if (current?.token !== token) return false;
          try {
            await writeFile(path, payload(), "utf8");
            return true;
          } catch {
            return false;
          }
        },
        release: async () => {
          let current: LockPayload | null;
          try {
            current = parsePayload(await readFile(path, "utf8"));
          } catch {
            return false;
          }
          if (current?.token !== token) return false;
          try {
            await unlink(path);
            return true;
          } catch {
            return false;
          }
        },
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (created) await unlink(path).catch(() => {});
      if ((error as { code?: string })?.code !== "EEXIST") throw error;
    }

    // Staleness is decided from mtime, before parsing. A zero-byte or corrupt
    // lock therefore still becomes recoverable once its holder stops writing.
    let stale = false;
    try {
      const info = await stat(path);
      stale = now() - info.mtimeMs > staleMs;
    } catch (error) {
      if ((error as { code?: string })?.code === "ENOENT") continue;
    }
    if (stale) {
      await unlink(path).catch(() => {});
      continue;
    }
    if (now() - startedAt >= waitMs) return null;
    if (options.signal?.aborted) return null;
    await sleep(pollMs);
  }
}
