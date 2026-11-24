// Swamp IDE approval: the human side of the capability lease. The addin writes
// a pending request; this mod shows a dialog and writes the decision. Approve
// also writes the scoped lease directly; the agent cannot do either.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { unlink } from "fs/promises";
import {
  checking,
  closeOverlay,
  exec,
  home,
  openOverlay,
  props,
  readTextFile,
  setShared,
  shared,
  theme,
  writeTextFile,
} from "herdr";

const STATE = home() + "/.local/state/swamp-agent-ide";
const PENDING = STATE + "/pending-approval.json";
const DECISION = STATE + "/approval-decision.json";
const LEASE = STATE + "/lease.json";
const LAST_REQUEST = STATE + "/last-request.txt";
const LAST_COPY = STATE + "/last-copy.txt";
const LAST_ERROR = STATE + "/approval-error.txt";
const OPEN_KEY = "swamp-ide-approval.open";
const DISMISSED_KEY = "swamp-ide-approval.dismissed";
const POLL_MS = 500;

function parse(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function logError(message) {
  try {
    const current = await readTextFile(LAST_ERROR).catch(() => null);
    const line = `${new Date().toISOString()} ${message}\n`;
    await writeTextFile(LAST_ERROR, `${current ?? ""}${line}`, current);
  } catch {
    // best effort
  }
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function remainingUntil(iso) {
  const ms = Date.parse(String(iso ?? "")) - Date.now();
  if (!isFinite(ms)) return "unknown";
  if (ms <= 0) return "expired";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function commandText(pending) {
  const command = pending?.command;
  if (!command || !Array.isArray(command.argv)) return "";
  return `${command.argv.map((part) => String(part)).join(" ")}\n\ncwd: ${command.cwd ?? ""}`;
}

function humanDuration(pending) {
  const ms = Number(pending?.durationMs ?? 600_000);
  if (!isFinite(ms) || ms <= 0) return "until revoked";
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Parent directory of an absolute file path, or "" when it is the root. */
function parentDirectory(path) {
  const clean = String(path ?? "").replace(/\/+$/, "");
  if (!clean || clean === "/") return "";
  const cut = clean.lastIndexOf("/");
  if (cut <= 0) return "";
  return clean.slice(0, cut);
}

/** Turn a machine scope into plain language a person can judge. */
function grantInfo(pending) {
  const scope = String(pending?.scope ?? "");
  const duration = humanDuration(pending);
  const command = commandText(pending).split("\n")[0] ?? "";
  const undo = "Revoke this grant in Swamp IDE > Leases (or run /swamp-ide revoke). Revoking stops future use; it does not undo changes already made.";

  if (scope.startsWith("protected:")) {
    const path = scope.slice("protected:".length);
    return {
      title: "Edit one protected file",
      body: `Allow the agent to edit exactly this file for ${duration}:`,
      target: path,
      path,
      allows: [
        `Edit this exact file as often as needed for ${duration}.`,
        "Make the change the agent just described.",
      ],
      denies: [
        "Any other file, including other protected gate/panel files.",
        "Shell commands, model methods, or future requests.",
      ],
      riskLevel: "HIGH",
      risks: [
        "This file is part of the agent gate, panel, addin or policy.",
        "A bad edit can change how approvals or routing work.",
        "The grant is reusable for every matching edit until it expires.",
        "Revoking does not revert files that were already changed.",
      ],
      undo,
    };
  }

  if (scope.startsWith("exec:") || scope.startsWith("run:")) {
    return {
      title: "Run one exact command",
      body: `Allow the agent to run this exact command for ${duration}:`,
      target: command,
      command,
      allows: [
        "Run this exact argv and cwd, with your user permissions.",
        "Repeat that same command until the grant expires.",
      ],
      denies: [
        "Any different command or extra shell syntax.",
        "A general-purpose shell or package manager.",
      ],
      riskLevel: "HIGH",
      risks: [
        "The command runs with your user permissions.",
        "It can change files, services, processes or remote state.",
        "The exact-command limit is narrower than a shell, but the command can still be destructive.",
        "Revoking does not undo what the command already did.",
      ],
      undo,
    };
  }

  if (scope.startsWith("file:")) {
    const path = scope.slice("file:".length);
    const directory = parentDirectory(path);
    return {
      title: "Edit one file",
      body: `Allow the agent to edit exactly this file for ${duration}:`,
      target: path,
      path,
      directory,
      directoryScope: directory ? `dir:${directory}` : "",
      allows: [
        `Edit this exact file as often as needed for ${duration}.`,
        "Make the change the agent just described.",
      ],
      denies: [
        "Any other file, even in the same directory.",
        "Shell commands, model methods, or future requests.",
      ],
      riskLevel: "HIGH",
      risks: [
        "The grant is limited to this one file.",
        "A bad edit can break the file or project behavior.",
        "Revoking does not revert changes already made.",
      ],
      undo,
    };
  }

  if (["file-edit", "file-write", "file-edit-lines"].includes(scope)) {
    return {
      title: "Edit any file (broad method grant)",
      body: `This is NOT limited to the file in the request. It grants the ${scope} method itself for ${duration}.`,
      target: "NO specific file — this is a broad method grant",
      targetWarning: true,
      allows: [
        `Use ${scope} on any path the agent can reach.`,
        "Apply changes unrelated to the request shown here.",
      ],
      denies: ["Other tools and methods, but only those."],
      riskLevel: "HIGH",
      risks: [
        "The scope is a whole method, not one path.",
        "The agent can edit files you did not see in this request.",
        "This is broader than the action being requested now.",
        "Approve only if you intend to allow file edits generally.",
      ],
      undo,
    };
  }

  if (scope.startsWith("swamp:")) {
    const method = scope.slice("swamp:".length);
    return {
      title: "Run one swamp model method",
      body: `Allow the agent to run ${method} for ${duration}.`,
      target: method,
      allows: [
        "Run this method on this model with the inputs shown.",
        "Repeat the method until the grant expires.",
      ],
      denies: [
        "Other methods on the same model.",
        "Any other model or a general swamp CLI call.",
      ],
      riskLevel: "MEDIUM",
      risks: [
        "The method can change live state, configuration or a dashboard.",
        "The grant is method-wide for every invocation until it expires.",
        "Review the inputs and effect before approving.",
      ],
      undo,
    };
  }

  return {
    title: "Grant one broad capability",
    body: `Allow the agent to use ${scope || "this capability"} for ${duration}.`,
    target: scope || "no target specified",
    targetWarning: true,
    allows: ["Use this capability until the grant expires."],
    denies: ["Anything outside this capability."],
    riskLevel: "HIGH",
    risks: [
      "The scope is not a single file or exact command.",
      "It may affect more than the action shown in this request.",
      "Revoking does not undo changes already made.",
    ],
    undo,
  };
}

/** The wider alternative offered for an exact file request. */
function directoryGrantInfo(pending) {
  const info = grantInfo(pending);
  const directory = info.directory || "";
  const duration = humanDuration(pending);
  return {
    ...info,
    title: "Edit files in one directory",
    body: `Allow the agent to edit any file under this directory for ${duration}:`,
    target: directory,
    path: directory,
    allows: [
      `Edit any file under ${directory} for ${duration}.`,
      "Use sibling files in that directory if the task needs them.",
    ],
    denies: [
      `Files outside ${directory}.`,
      "Shell commands, model methods, or other directories.",
    ],
    riskLevel: "HIGH",
    risks: [
      "This is wider than the single file in the request.",
      `Every file under ${directory} can be edited, not just the requested file.`,
      "Revoking does not revert changes already made.",
    ],
  };
}

/** The complete request, as text: everything the dialog shows plus ids. */
function requestText(pending) {
  if (!pending) return "";
  const lines = [
    "Swamp IDE approval request",
    "",
    `id: ${pending.id ?? ""}`,
    `session: ${pending.session ?? ""}`,
    `created: ${pending.createdAt ?? ""}`,
    `expires: ${pending.expiresAt ?? "no timeout"}`,
    `risk: ${pending.risk ?? ""}`,
    `scope: ${pending.scope ?? ""}`,
    `system: ${pending.system ?? ""}`,
    `model: ${pending.model ?? ""}`,
    `method: ${pending.method ?? ""}`,
    `path: ${pending.path ?? ""}`,
    "",
    "Why:",
    String(pending.reason ?? ""),
    "",
    "What it achieves:",
    String(pending.goal ?? ""),
    "",
    "Effect:",
    String(pending.effect ?? ""),
  ];
  const info = grantInfo(pending);
  lines.push(
    "",
    "You are granting:",
    info.title,
    info.body,
    ...(info.target ? [`Target: ${info.target}`] : []),
    ...(info.path ? [info.path] : []),
    ...(info.command ? [info.command] : []),
    ...(info.directory
      ? [
        "",
        "Directory alternative:",
        info.directory,
        `This grants edits to any file under that directory for ${humanDuration(pending)}.`,
      ]
      : []),
    "",
    "Allows:",
    ...info.allows.map((item) => `- ${item}`),
    "",
    "Does not allow:",
    ...info.denies.map((item) => `- ${item}`),
    "",
    `Risk: ${info.riskLevel}`,
    ...info.risks.map((item) => `- ${item}`),
    "",
    "Undo:",
    info.undo,
  );
  if (pending.input && Object.keys(pending.input).length > 0) {
    lines.push("", "Inputs:", JSON.stringify(pending.input, null, 2));
  }
  const command = commandText(pending);
  if (command) lines.push("", "Command:", command);
  return lines.join("\n") + "\n";
}

async function writeJson(path, value) {
  const current = await readTextFile(path).catch(() => null);
  await writeTextFile(path, JSON.stringify(value, null, 2), current);
}

export default class SwampIdeApproval extends View {
  init(_props, cx) {
    this.pending = null;
    this.pendingId = "";
    this.error = "";
    this.copied = "";
    this.busy = false;
    this.resolved = false;
    this.overlay = props()?.overlay ?? "";
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  async refresh(cx) {
    this.pending = parse(await readTextFile(PENDING).catch(() => null));
    if (this.pending?.id !== this.pendingId) {
      this.pendingId = this.pending?.id ?? "";
      this.error = "";
    }
    if (this.pending && String(shared(DISMISSED_KEY) ?? "") === this.pending.id) {
      // Closing the dialog resolves the request; it must never reopen for the
      // same id while the addin is finishing up.
      this.pending = null;
    }

    if (!this.overlay && !checking()) {
      const open = String(shared(OPEN_KEY) ?? "");
      if (this.pending && !open) {
        const id = openOverlay({
          mod: "swamp-ide-approval",
          props: { requestId: this.pending.id },
          kind: "dialog",
          width: 560,
          height: 520,
          modal: true,
        });
        setShared(OPEN_KEY, id);
      } else if (!this.pending && open) {
        closeOverlay(open);
        setShared(OPEN_KEY, "");
      }
    }
    cx.notify();
  }

  /** Herdr calls this for X, Esc and every other overlay close. It is also
   * called after a button writes its decision. An unresolved close writes a
   * `fallback` decision and drops the pending request, so the addin returns
   * the explicit `/swamp-ide approve ...` error immediately instead of
   * waiting for the timeout. */
  async close(cx) {
    const pending = this.pending;
    if (pending?.id && !this.resolved) {
      try {
        await writeJson(DECISION, {
          id: pending.id,
          decision: "fallback",
          at: new Date().toISOString(),
        });
        await unlink(PENDING).catch(() => {});
      } catch (error) {
        this.error = String(error?.message ?? error);
        void logError(`close: ${this.error}`);
      }
      setShared(DISMISSED_KEY, pending.id);
    }
    const open = this.overlay || String(shared(OPEN_KEY) ?? "");
    if (open) closeOverlay(open);
    setShared(OPEN_KEY, "");
    this.pending = null;
    this.overlay = "";
    this.resolved = false;
    cx.notify();
  }

  async decide(decision, cx) {
    const pending = this.pending;
    if (!pending || !pending.id) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try {
      if (decision === "approve" || decision === "approve-directory") {
        const info = grantInfo(pending);
        const directoryGrant = decision === "approve-directory";
        const scope = directoryGrant ? info.directoryScope : pending.scope;
        if (!scope) {
          throw new Error("this request has no directory to grant");
        }
        const scopeInfo = directoryGrant ? directoryGrantInfo(pending) : info;
        let saved = false;
        let lastError = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          const currentText = await readTextFile(LEASE).catch(() => null);
          const current = parse(currentText) ?? {};
          const scopes = new Set([...(current.scopes ?? []), scope]);
          const scopeExpiry = { ...(current.scopeExpiry ?? {}) };
          const expires = new Date(
            Date.now() + Number(pending.durationMs ?? 600_000),
          ).toISOString();
          scopeExpiry[scope] = expires;
          const features = { ...(current.features ?? {}) };
          features[`approval:${pending.id}`] = {
            scopes: [scope],
            untilRevoked: false,
            expiresAt: expires,
            session: pending.session || current.session || "",
            purpose: `${scopeInfo.title}: ${pending.goal || pending.reason || ""}`.trim(),
            risk: scopeInfo.riskLevel,
            requestId: pending.id,
            requestedAt: pending.createdAt ?? new Date().toISOString(),
          };
          const expiries = [
            ...Object.values(scopeExpiry),
            ...Object.values(features).map((feature) => feature.expiresAt),
          ].filter(Boolean).map((value) => Date.parse(String(value)));
          const next = {
            session: current.session || pending.session || "",
            features,
            scopes: [...scopes],
            scopeExpiry,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Math.max(...expiries, Date.now())).toISOString(),
          };
          try {
            await writeTextFile(LEASE, JSON.stringify(next, null, 2), currentText);
            saved = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!saved) {
          throw lastError ?? new Error("lease update did not commit");
        }
      }
      await writeJson(DECISION, {
        id: pending.id,
        decision: "approve",
        at: new Date().toISOString(),
      });
      this.resolved = true;
      this.error = "";
      await unlink(PENDING).catch(() => {});
      setShared(DISMISSED_KEY, pending.id);
      await this.close(cx);
    } catch (error) {
      this.error = String(error?.message ?? error);
      void logError(`decide(${decision}): ${this.error}`);
      this.resolved = false;
    } finally {
      this.busy = false;
      cx.notify();
    }
  }

  /** Copy needs no decision: it only records the request where a person can
   * read it. Herdr mods have no text selection, so this is the only way to
   * get the full request out of the dialog. */
  async copy(cx) {
    const text = requestText(this.pending);
    if (!text) return;
    this.error = "";
    try {
      const current = await readTextFile(LAST_REQUEST).catch(() => null);
      await writeTextFile(LAST_REQUEST, text, current);
    } catch (error) {
      this.error = `could not write ${LAST_REQUEST}: ${String(error?.message ?? error)}`;
    }
    try {
      cx.write_to_clipboard(text);
    } catch {
      // Native clipboard may be unavailable under a bare compositor.
    }
    // Also hand it to the usual Wayland/X11 tools; either may be absent.
    const copied = await exec("wl-copy", [text]).then((r) => r.code === 0)
      .catch(() => false);
    if (!copied) {
      await exec("xclip", ["-selection", "clipboard", LAST_REQUEST])
        .catch(() => null);
    }
    this.copied = "full request copied";
    cx.notify();
  }

  async copyText(text, label, cx) {
    const value = String(text ?? "").trim();
    if (!value) return;
    this.error = "";
    this.copied = "";
    try {
      cx.write_to_clipboard(value);
    } catch {
      // Fall through to the desktop clipboard tools.
    }
    let copied = false;
    try {
      const result = await exec("wl-copy", [value]);
      copied = result.code === 0;
    } catch {
      // wl-copy may be unavailable.
    }
    if (!copied) {
      try {
        await writeTextFile(LAST_COPY, value);
        const result = await exec("xclip", [
          "-selection",
          "clipboard",
          LAST_COPY,
        ]);
        copied = result.code === 0;
      } catch {
        // Native clipboard is optional.
      }
    }
    this.copied = copied
      ? `${label} copied`
      : `${label} saved to ${LAST_COPY}`;
    cx.notify();
  }

  copyableText(t, id, text, label, cx, size = 12) {
    const value = String(text ?? "");
    return div()
      .id(id)
      .w_full()
      .min_w(0)
      .whitespace_normal()
      .text_size(size)
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, inner) => {
        inner.stop_propagation();
        void this.copyText(value, label, inner);
      })
      .child(value);
  }

  button(t, label, bg, fg, border, action) {
    return h_flex()
      .h(28)
      .px(10)
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(border)
      .bg(bg)
      .text_color(fg)
      .text_size(12)
      .cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click(action)
      .child(label);
  }

  render(cx) {
    const t = theme();
    if (!this.overlay) return div().size(0);

    const pending = this.pending;
    const command = commandText(pending);
    const inputText = pending?.input &&
        Object.keys(pending.input).length > 0
      ? JSON.stringify(pending.input, null, 2).slice(0, 4000)
      : "";
    const approvalMinutes = pending?.durationMs
      ? Math.round(pending.durationMs / 60000)
      : 10;
    const expiry = pending?.expiresAt
      ? new Date(pending.expiresAt).toLocaleTimeString()
      : "";
    const body = v_flex().gap(10).p(12).w_full().min_w(0);
    const info = pending ? grantInfo(pending) : null;
    const alternatives = Array.isArray(pending?.alternatives)
      ? pending.alternatives
      : [];
    const riskColor = info?.riskLevel === "HIGH"
      ? t.blocked
      : info?.riskLevel === "MEDIUM"
      ? t.ansi3
      : t.working;

    if (!pending) {
      body.child(div().text_size(13).text_color(t.muted).child("No pending approval."));
    } else {
      body.child(
        div().w_full().min_w(0).whitespace_normal().text_size(12).text_color(t.muted).child(
          `${pending.session ? "session " + String(pending.session).slice(0, 8) : "new request"} · waiting for your decision`,
        ),
      );
      body.child(
        v_flex().gap(4).p(8).rounded(6).bg(t.chrome).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Target"))
          .child(this.copyableText(t, "approval-target", info.target ?? "no target specified", "target", cx)),
      );
      if (info.directoryScope) {
        body.child(
          v_flex().gap(4).p(8).rounded(6).bg(t.raised).min_w(0)
            .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Directory alternative"))
            .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(
              `Grant edits to any file under ${info.directory} for ${approvalMinutes}m, instead of only ${info.path}.`,
            ))
            .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.dim).child(
              "Use this when you are happy with that wider scope and want to avoid approving each file individually.",
            )),
        );
      }
      if (alternatives.length > 0) {
        body.child(
          v_flex().gap(4).p(8).rounded(6).bg(t.raised).min_w(0)
            .child(div().text_size(12).font_semibold().text_color(t.blocked).child("Use the internal tool"))
            .children(alternatives.map((alternative) =>
              div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(
                `Use swamp_ide system=${alternative.system} method=${alternative.method} instead of ${alternative.program}: ${alternative.reason}`,
              )
            )),
        );
      }
      if (pending.broad === true) {
        body.child(
          v_flex().gap(3).p(8).rounded(6).bg(t.raised).min_w(0)
            .child(div().text_size(12).font_semibold().text_color(t.blocked).child("Request is too broad"))
            .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(
              "Reject this and ask the agent to be more specific to the job it is trying to do.",
            )),
        );
      }
      body.child(
        v_flex().gap(4).p(8).rounded(6).bg(t.selected).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("You are granting"))
          .child(div().text_size(13).text_color(t.foreground).child(info.title))
          .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(info.body))
          .when(Boolean(info.path), (el) =>
            el.child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.ansi2).child(info.path)))
          .when(Boolean(info.command), (el) =>
            el.child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.ansi2).child(info.command))),
      );
      body.child(
        v_flex().gap(4).p(8).rounded(6).bg(t.raised).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Why the agent is asking"))
          .child(this.copyableText(t, "approval-reason", pending.reason ?? "", "reason", cx)),
      );
      body.child(
        v_flex().gap(4).p(8).rounded(6).bg(t.raised).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("What approving lets it do"))
          .child(this.copyableText(t, "approval-goal", pending.goal ?? "", "goal", cx)),
      );
      body.child(
        v_flex().gap(4).p(8).rounded(6).bg(t.chrome).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Action"))
          .child(div().w_full().min_w(0).whitespace_normal().text_size(12).text_color(t.foreground).child(
            `${pending.system ?? "?"} / ${pending.model ?? "?"}.${pending.method ?? "?"}`,
          ))
          .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(`scope: ${pending.scope}`))
          .when(Boolean(pending.path), (el) =>
            el.child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(`path: ${pending.path}`))),
      );
      body.child(
        v_flex().gap(4).p(8).rounded(6).bg(t.raised).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("What it will do next"))
          .child(div().w_full().min_w(0).whitespace_normal().text_size(12).text_color(t.foreground).child(pending.effect ?? "")),
      );
      body.child(
        v_flex().gap(3).p(8).rounded(6).bg(t.raised).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("What this allows"))
          .children(info.allows.map((item) =>
            div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.foreground).child(`• ${item}`)
          )),
      );
      body.child(
        v_flex().gap(3).p(8).rounded(6).bg(t.raised).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("What this does not allow"))
          .children(info.denies.map((item) =>
            div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(`• ${item}`)
          )),
      );
      body.child(
        v_flex().gap(3).p(8).rounded(6).bg(t.raised).min_w(0)
          .child(
            h_flex().items_center().gap(6)
              .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Risk"))
              .child(div().px(6).py(2).rounded(4).bg(riskColor).text_color(t.background).text_size(10).font_semibold().child(info.riskLevel)),
          )
          .children(info.risks.map((item) =>
            div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(`• ${item}`)
          )),
      );
      body.child(
        v_flex().gap(3).p(8).rounded(6).bg(t.chrome).min_w(0)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("How to undo"))
          .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(info.undo)),
      );
      if (inputText) {
        body.child(
          v_flex().gap(4).p(8).rounded(6).bg(t.chrome).min_w(0)
            .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Inputs"))
            .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(inputText)),
        );
      }
      if (command) {
        body.child(
          v_flex().gap(4).p(8).rounded(6).bg(t.chrome).min_w(0)
            .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Command"))
            .child(this.copyableText(t, "approval-command", command, "command", cx, 11)),
        );
      }
      body.child(
        v_flex().gap(3).p(8).rounded(6).bg(t.raised).min_w(0)
          .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(
            `Lease: ${approvalMinutes}m · waiting for your decision`,
          ))
          .child(div().w_full().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(
            "Approving writes this lease and runs the action immediately. Denying or closing changes nothing.",
          )),
      );
    }

    const footer = h_flex().h(48).px(12).py(8).flex_none().items_center().gap(8)
      .border_t_1().border_color(t.border);
    if (pending?.broad === true) {
      footer.child(
        this.button(t, "Reject broad", t.surface, t.blocked, t.blocked, (_e, cx) => this.decide("too-broad", cx)),
      );
    }
    if (alternatives.length > 0) {
      footer.child(
        this.button(t, `Use ${alternatives[0].method}`, t.solid, t.solid_foreground, t.solid, (_e, cx) => this.decide("use-tool", cx)),
      );
    }
    if (pending) {
      footer.child(
        div().flex_1().min_w(0).text_size(11).text_color(this.error ? t.blocked : t.working).child(this.error || this.copied),
      );
      footer.child(
        this.button(t, "Copy", t.surface, t.foreground, t.input, (_e, cx) => this.copy(cx)),
      );
      footer.child(
        this.button(t, "Explain", t.surface, t.foreground, t.input, (_e, cx) => this.decide("explain", cx)),
      );
      footer.child(
        this.button(t, "Deny", t.surface, t.foreground, t.blocked, (_e, cx) => this.decide("deny", cx)),
      );
      if (info?.directoryScope) {
        footer.child(
          this.button(t, "Grant directory", t.surface, t.foreground, t.input, (_e, cx) => this.decide("approve-directory", cx)),
        );
      }
      footer.child(
        this.button(t, "Approve", t.solid, t.solid_foreground, t.solid, (_e, cx) => this.decide("approve", cx)),
      );
    }

    return v_flex().id("root").size_full().w_full().min_h(0).overflow_hidden().bg(t.chrome).text_size(13)
      .child(
        h_flex().h(36).px(12).flex_none().items_center().gap(8).border_b_1().border_color(t.border)
          .child(div().flex_1().font_semibold().text_color(t.foreground).child("Swamp IDE approval"))
          .child(this.button(t, "×", t.chrome, t.muted, t.border, (_e, cx) => this.close(cx))),
      )
      .child(div().id("scroll").flex_1().min_h(0).min_w(0).w_full().overflow_y_scrollbar().mode("always").child(body))
      .child(footer);
  }
}
