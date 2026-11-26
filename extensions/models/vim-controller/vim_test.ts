/**
 * Tests for `@svendowideit/vim`.
 *
 * The Vim server interactions are exercised against a real server in the
 * extension's smoke workflow. These tests cover the pure edit planner, the
 * diff, the hash and the model surface so an ambiguous edit or a renamed
 * method is caught without a running Vim.
 *
 * @module
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  applyEdits,
  autoOpenPlan,
  coreStateLive,
  deriveServerName,
  EXT_TYPE,
  EXT_VERSION,
  findTabInSpace,
  findTabsInSpace,
  findTerminalPlacement,
  model,
  sha256Hex,
  spaceServerName,
  tabHasLiveTerminal,
  unifiedDiff,
  vimArgv,
} from "./vim.ts";

/** A trimmed `herdr-app ls` snapshot: two spaces, one has the pi pane. */
const LS = {
  spaces: [
    {
      id: "sp-other",
      name: "JukeBox",
      folder: "/home/sven/src/JukeBox",
      machine: null,
      tabs: [
        {
          id: "tbJuke",
          name: "Pi",
          terminals: [{ terminal: "t22", pane: "p-juke", status: "idle" }],
        },
      ],
    },
    {
      id: "sp-swamp",
      name: "swamp-project",
      folder: "/home/sven",
      machine: "xeon",
      tabs: [
        {
          id: "tbPi",
          name: "Pi",
          terminals: [
            { terminal: "t2g", pane: "p-pi", status: "working" },
            { terminal: "t2f", pane: "p-sh", status: "live" },
          ],
        },
        {
          id: "tbEdit",
          name: "Edit",
          terminals: [{ terminal: "t9v", pane: "p-vim", status: "live" }],
        },
      ],
    },
  ],
};

Deno.test("deriveServerName makes a stable server from the cwd", () => {
  assertEquals(
    deriveServerName("swamp-vim", "/home/sven/src/swamp-project"),
    "swamp-vim-swamp-project",
  );
  assertEquals(
    deriveServerName("swamp-vim", "C:\\Users\\sven\\project"),
    "swamp-vim-project",
  );
  assertEquals(deriveServerName("swamp-vim", "/"), "swamp-vim-vim");
});

Deno.test("spaceServerName names one server per space", () => {
  assertEquals(
    spaceServerName("swamp-vim", "swamp-project", "sp-swamp"),
    "swamp-vim-swamp-project",
  );
  // An unnamed space falls back to its id tail, so it is still stable.
  assertEquals(
    spaceServerName("swamp-vim", "", "sp123456789abcdef"),
    "swamp-vim-89abcdef",
  );
  assertEquals(
    spaceServerName("swamp-vim", "My Space / 2", "sp-1"),
    "swamp-vim-my-space-2",
  );
  assertEquals(spaceServerName("swamp-vim", "", ""), "swamp-vim-vim");
});

Deno.test("vimArgv is the exact program placed in the editor tab", () => {
  assertEquals(vimArgv("vim", "swamp-vim-repo", "src/a.ts"), [
    "vim",
    "--servername",
    "swamp-vim-repo",
    "-n",
    "src/a.ts",
  ]);
  assertEquals(vimArgv("vim", "swamp-vim-repo", ""), [
    "vim",
    "--servername",
    "swamp-vim-repo",
    "-n",
  ]);
});

Deno.test("findTerminalPlacement maps this pane to its space, tab and machine", () => {
  assertEquals(findTerminalPlacement(LS, "t2g"), {
    machine: "xeon",
    space: "sp-swamp",
    spaceName: "swamp-project",
    tab: "tbPi",
    tabName: "Pi",
    pane: "p-pi",
    terminal: "t2g",
  });
  assertEquals(findTerminalPlacement(LS, "nope"), null);
  assertEquals(findTerminalPlacement(LS, ""), null);
  assertEquals(findTerminalPlacement({}, "t2g"), null);
  assertEquals(findTerminalPlacement(null, "t2g"), null);
});

Deno.test("findTabInSpace finds the editor tab and its terminals", () => {
  assertEquals(findTabInSpace(LS, "sp-swamp", "Edit"), {
    tab: "tbEdit",
    tabName: "Edit",
    terminals: [{ terminal: "t9v", pane: "p-vim", status: "live" }],
  });
  assertEquals(findTabInSpace(LS, "sp-swamp", "Nope"), null);
  assertEquals(findTabInSpace(LS, "sp-other", "Edit"), null);
  assertEquals(findTabInSpace(LS, "", "Edit"), null);
});

Deno.test("applyEdits replaces exactly one old string", () => {
  assertEquals(
    applyEdits(["alpha", "beta", "gamma"], [{ old: "beta", new: "BETA" }]),
    ["alpha", "BETA", "gamma"],
  );
  assertEquals(
    applyEdits(["one", "two"], [{ old: "one\ntwo", new: "three" }]),
    ["three"],
  );
});

Deno.test("applyEdits rejects a missing or ambiguous old string", () => {
  assertThrows(
    () => applyEdits(["alpha"], [{ old: "missing", new: "x" }]),
    Error,
    "old text not found",
  );
  assertThrows(
    () => applyEdits(["a", "a"], [{ old: "a", new: "b" }]),
    Error,
    "occurs 2 times",
  );
  assertThrows(
    () => applyEdits(["alpha"], [{ old: "", new: "x" }]),
    Error,
    "empty old string",
  );
});

Deno.test("applyEdits replaces a 1-indexed line range", () => {
  assertEquals(
    applyEdits(["a", "b", "c", "d"], [{
      startLine: 2,
      endLine: 3,
      lines: ["B", "C", "extra"],
    }]),
    ["a", "B", "C", "extra", "d"],
  );
  assertEquals(
    applyEdits(["a", "b", "c"], [{ startLine: 2, endLine: 2, lines: [] }]),
    ["a", "c"],
  );
});

Deno.test("applyEdits replaces the whole buffer with setLines", () => {
  assertEquals(
    applyEdits(["old"], [{ setLines: ["new", "buffer"] }]),
    ["new", "buffer"],
  );
  assertEquals(applyEdits(["old"], [{ setLines: [] }]), [""]);
});

Deno.test("applyEdits rejects an out-of-range line edit", () => {
  assertThrows(
    () => applyEdits(["a"], [{ startLine: 2, endLine: 2, lines: ["b"] }]),
    Error,
    "starts past the buffer",
  );
  assertThrows(
    () => applyEdits(["a"], [{ startLine: 1, endLine: 2, lines: ["b"] }]),
    Error,
    "ends past the buffer",
  );
});

Deno.test("unifiedDiff shows the changed line with context", () => {
  const diff = unifiedDiff(
    ["one", "two", "three"],
    ["one", "TWO", "three"],
    "f.txt",
  );
  assert(diff.includes("--- a/f.txt"));
  assert(diff.includes("+++ b/f.txt"));
  assert(diff.includes("-two"));
  assert(diff.includes("+TWO"));
  assert(diff.includes(" one"));
  assertEquals(unifiedDiff(["same"], ["same"], "f.txt"), "");
});

Deno.test("sha256Hex is the standard SHA-256 of the text", async () => {
  assertEquals(
    await sha256Hex("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("model exposes the Vim type and the phase-two methods", () => {
  assertEquals(model.type, EXT_TYPE);
  assertEquals(model.version, EXT_VERSION);
  assertEquals(model.type, "@svendowideit/vim-controller");
  const methods = Object.keys(model.methods).sort();
  for (
    const expected of [
      "annotate",
      "close",
      "command",
      "cursor",
      "diagnostics",
      "diff",
      "edit",
      "expr",
      "focus",
      "keys",
      "open",
      "otel-status",
      "read",
      "select",
      "servers",
      "status",
      "undo",
      "write",
    ]
  ) {
    assert(methods.includes(expected), `missing method ${expected}`);
  }
});

Deno.test("every Vim method has a description and an execute function", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    assert(
      typeof method.description === "string" && method.description.length > 20,
      `${name} has no meaningful description`,
    );
    assertEquals(typeof method.execute, "function");
  }
});

Deno.test("open defaults to the per-space editor tab", () => {
  const parsed = model.methods.open.arguments.parse({});
  assertEquals(parsed.place, "tab");
  assertEquals(parsed.reuse, true);
});

Deno.test("focus takes a server, and optional explicit terminal and tab", () => {
  const parsed = model.methods.focus.arguments.parse({ server: "s" });
  assertEquals(parsed.server, "s");
  assertEquals(parsed.terminal, "");
  assertEquals(parsed.tab, "");
});

Deno.test("the editor tab name is a global argument", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.editorTab, "Edit");
  assertEquals(parsed.herdrAppBin, "herdr-app");
});

Deno.test("the model literals stay in step with the exported constants", () => {
  // The registry catalogue reads only string literals in the model object, so
  // the type and version are repeated there; this keeps the two in step.
  assertEquals(model.type, EXT_TYPE);
  assertEquals(model.version, EXT_VERSION);
  assertEquals(EXT_TYPE, "@svendowideit/vim-controller");
});

Deno.test("autoOpenPlan reopens the tab on the file open last recorded", () => {
  const plan = autoOpenPlan(
    { file: "src/a.ts", cwd: "/repo" },
    "/fallback",
  );
  assertEquals(plan.file, "src/a.ts");
  assertEquals(plan.cwd, "/repo");
  assertEquals(plan.reason, "reopened the editor tab on src/a.ts");
});

Deno.test("autoOpenPlan falls back to a cwd and says there is no file", () => {
  const plan = autoOpenPlan(null, "/fallback");
  assertEquals(plan.file, "");
  assertEquals(plan.cwd, "/fallback");
  assertEquals(
    plan.reason,
    "reopened the editor tab with no file; call open with a file to load one",
  );
  // A stored record with no file still keeps the recorded cwd.
  const half = autoOpenPlan({ cwd: "/repo" }, "/fallback");
  assertEquals(half.file, "");
  assertEquals(half.cwd, "/repo");
});

Deno.test("autoOpen defaults on so a closed tab comes back", () => {
  assertEquals(model.globalArguments.parse({}).autoOpen, true);
});

Deno.test("coreStateLive reads herdr-core's state, not herdr-app's status", () => {
  // herdr-app ls reports no status for a vim terminal; hc ls --all reports
  // state live/finished, which is the only trustworthy answer.
  assertEquals(coreStateLive("live"), true);
  assertEquals(coreStateLive("working"), true);
  assertEquals(coreStateLive("finished"), false);
  assertEquals(coreStateLive("exited"), false);
  assertEquals(coreStateLive(""), false);
});

Deno.test("tabHasLiveTerminal treats an untracked terminal as dead", () => {
  const tab = {
    tab: "t",
    tabName: "Edit",
    terminals: [
      { terminal: "t1", pane: "p1", status: "" },
      { terminal: "t2", pane: "p2", status: "" },
    ],
  };
  assertEquals(tabHasLiveTerminal(tab, new Map()), false);
  assertEquals(tabHasLiveTerminal(tab, new Map([["t2", "live"]])), true);
  assertEquals(
    tabHasLiveTerminal(tab, new Map([["t1", "finished"], ["t2", "finished"]])),
    false,
  );
});

Deno.test("findTabsInSpace returns every duplicate so a dead one is not hidden", () => {
  const ls = {
    spaces: [{
      id: "sp",
      name: "space",
      tabs: [
        {
          id: "t-old",
          name: "Edit",
          terminals: [{ terminal: "t1", pane: "p1" }],
        },
        {
          id: "t-new",
          name: "Edit",
          terminals: [{ terminal: "t2", pane: "p2", status: "live" }],
        },
        { id: "t-pi", name: "Pi", terminals: [{ terminal: "t3", pane: "p3" }] },
      ],
    }],
  };
  assertEquals(findTabsInSpace(ls, "sp", "Edit").map((tab) => tab.tab), [
    "t-old",
    "t-new",
  ]);
  assertEquals(findTabInSpace(ls, "sp", "Edit")?.tab, "t-old");
  assertEquals(findTabsInSpace(ls, "sp", "Nope"), []);
  // With duplicates, only one is live: the dead one is the one to close.
  const states = new Map([["t2", "live"]]);
  const dead = findTabsInSpace(ls, "sp", "Edit").filter((tab) =>
    !tabHasLiveTerminal(tab, states)
  );
  assertEquals(dead.map((tab) => tab.tab), ["t-old"]);
});
