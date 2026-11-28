/**
 * Tests for `@svendowideit/herdr-core`.
 *
 * The CLI interactions are exercised by the extension's own smoke workflow; the
 * tests here cover the pure pieces and the model surface so a broken method
 * name or resource spec is caught without a live terminal.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  applyLineEdits,
  decidePiResume,
  decodeBase64,
  EXT_TYPE,
  EXT_VERSION,
  model,
  sha256Hex,
  splitTextLines,
} from "./herdr_core.ts";

Deno.test("decodeBase64 decodes the herdr-core exec stdout shape", () => {
  assertEquals(decodeBase64("aGVsbG8K"), "hello\n");
  assertEquals(decodeBase64(""), "");
  assertEquals(decodeBase64("not base64!!"), "");
});

const DAY = 86_400_000;
const daysAgo = (days: number) => Date.now() - days * DAY;

/** A terminal that carries a live pi record, overridable per case. */
function recorded(over: Record<string, unknown> = {}) {
  return {
    agent: "bash",
    liveState: "live",
    herdrReason: "",
    labels: { "pi.session": "abc123", "pi.state": "running" } as Record<
      string,
      string
    >,
    createdAtMs: daysAgo(1),
    ...over,
  };
}

Deno.test("decidePiResume ignores a terminal with no pi record", () => {
  const verdict = decidePiResume(recorded({ labels: {} }), Date.now(), 14);
  assertEquals(verdict.decision, "skip");
  assertEquals(verdict.why, "no pi session recorded");
});

Deno.test("decidePiResume never brings back a session a person quit", () => {
  const verdict = decidePiResume(
    recorded({
      liveState: "finished",
      herdrReason: "exited",
      labels: {
        "pi.session": "abc123",
        "pi.state": "exited",
        "pi.end": "quit",
      },
    }),
    Date.now(),
    14,
  );
  assertEquals(verdict.decision, "skip");
  assertEquals(verdict.why, "left deliberately (quit)");
});

Deno.test("decidePiResume resumes every way the host ends a program", () => {
  for (
    const reason of [
      "host_shutdown",
      "server_stop",
      "holder_lost",
      "signaled",
      "stopped_by_restart",
    ]
  ) {
    const verdict = decidePiResume(
      recorded({ liveState: "finished", herdrReason: reason }),
      Date.now(),
      14,
    );
    assertEquals(verdict.decision, "resume", reason);
    assertEquals(verdict.why, "host ended it (" + reason + ")");
  }
});

Deno.test("decidePiResume leaves a program the person ended alone", () => {
  for (const reason of ["exited", "killed"]) {
    const verdict = decidePiResume(
      recorded({ liveState: "finished", herdrReason: reason }),
      Date.now(),
      14,
    );
    assertEquals(verdict.decision, "skip", reason);
    assertEquals(verdict.why, "you ended it (" + reason + ")");
  }
});

Deno.test("decidePiResume leaves a session that is still running", () => {
  const verdict = decidePiResume(recorded({ agent: "pi" }), Date.now(), 14);
  assertEquals(verdict.decision, "skip");
  assertEquals(verdict.why, "session is still running");
});

Deno.test("decidePiResume resumes a shell where pi used to be", () => {
  // The reboot case: the record says running, the tab still points at the
  // terminal, and a shell sits where pi was.
  const verdict = decidePiResume(recorded(), Date.now(), 14);
  assertEquals(verdict.decision, "resume");
  assertEquals(verdict.why, "program lost when the host restarted");
});

Deno.test("decidePiResume does not resurrect a stale session", () => {
  const verdict = decidePiResume(
    recorded({ createdAtMs: daysAgo(30) }),
    Date.now(),
    14,
  );
  assertEquals(verdict.decision, "skip");
  assertEquals(verdict.why, "stale: 30 days old");
});

Deno.test("decidePiResume keeps a session inside the age window", () => {
  const verdict = decidePiResume(
    recorded({ createdAtMs: daysAgo(13) }),
    Date.now(),
    14,
  );
  assertEquals(verdict.decision, "resume");
});

Deno.test("model exposes the herdr-core type and a stable version", () => {
  assertEquals(model.type, EXT_TYPE);
  assertEquals(model.version, EXT_VERSION);
  assertEquals(model.type, "@svendowideit/herdr-core");
  assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version));
});

Deno.test("splitTextLines preserves the trailing-newline fact", () => {
  assertEquals(splitTextLines("a\nb\n"), {
    lines: ["a", "b"],
    trailingNewline: true,
  });
  assertEquals(splitTextLines("a\nb"), {
    lines: ["a", "b"],
    trailingNewline: false,
  });
  assertEquals(splitTextLines(""), {
    lines: [""],
    trailingNewline: false,
  });
});

Deno.test("applyLineEdits replaces a range and can check expected lines", () => {
  assertEquals(
    applyLineEdits(["a", "b", "c", "d"], [{
      startLine: 2,
      endLine: 3,
      lines: ["B", "C"],
      expectedLines: ["b", "c"],
    }]),
    ["a", "B", "C", "d"],
  );
  assertEquals(
    applyLineEdits(["a", "b"], [{ startLine: 3, endLine: 2, lines: ["c"] }]),
    ["a", "b", "c"],
  );
});

Deno.test("applyLineEdits refuses stale or out-of-range ranges", () => {
  let message = "";
  try {
    applyLineEdits(["a", "b"], [{
      startLine: 1,
      expectedLines: ["a", "changed"],
      lines: ["x"],
    }]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("no longer"));
  message = "";
  try {
    applyLineEdits(["a"], [{ startLine: 3, lines: ["x"] }]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("starts past"));
});

Deno.test("sha256Hex is the standard SHA-256 of the text", async () => {
  assertEquals(
    await sha256Hex("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("model has the phase-one methods", () => {
  const methods = Object.keys(model.methods).sort();
  for (
    const expected of [
      "exec",
      "file-edit",
      "file-edit-lines",
      "file-read",
      "file-write",
      "interrupt",
      "keys",
      "kill",
      "machine-add",
      "machine-remove",
      "machines",
      "otel-status",
      "put",
      "read",
      "rm",
      "run",
      "search",
      "send",
      "status",
      "terminals",
      "wait",
    ]
  ) {
    assert(methods.includes(expected), `missing method ${expected}`);
  }
});

Deno.test("model declares the data the methods write", () => {
  const resources = Object.keys(model.resources).sort();
  for (
    const expected of [
      "exec-result",
      "fleet",
      "machines",
      "otel-status",
      "read-result",
      "run-result",
      "search-result",
      "status",
      "terminal",
    ]
  ) {
    assert(resources.includes(expected), `missing resource ${expected}`);
  }
});

Deno.test("every method has a description and an execute function", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    assert(
      typeof method.description === "string" && method.description.length > 20,
      `${name} has no meaningful description`,
    );
    assertEquals(typeof method.execute, "function");
  }
});
