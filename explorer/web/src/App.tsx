import React from "react";
import { ReactFlow as ReactFlowComponent, Background, Controls, MiniMap, type Node, type Edge, type NodeProps, Handle, Position, BackgroundVariant } from "@xyflow/react";
const ReactFlow = ReactFlowComponent as unknown as typeof import("@xyflow/react").ReactFlow;
import "@xyflow/react/dist/style.css";
import {
  api,
  type ModelSummary,
  type ModelDetail,
  type TypeDetail,
  type WorkflowSummary,
  type WorkflowDetail,
  type DataListResponse,
  type DataListItem,
  type JsonSchema,
  type WorkflowStep,
} from "./api";
import { JsonViewer } from "./JsonViewer";
import { TriggerDialog } from "./TriggerDialog";

// ---------------------------------------------------------------------------
// Custom node types
// ---------------------------------------------------------------------------

type NodeData = {
  kind: "model" | "type" | "workflow" | "data";
  title: string;
  subtitle?: string;
  methods?: string[];
  selected?: boolean;
  onMethodClick?: (method: string) => void;
  onSelect?: () => void;
};

const SwampNode = ({ data }: NodeProps<Node>) => {
  const d = data as unknown as NodeData;
  const cls = `swamp-node ${d.kind}${d.selected ? " selected" : ""}`;
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className={cls} onClick={d.onSelect}>
        <div className="node-title">
          {d.title}
        </div>
        {d.subtitle && <div className="node-sub">{d.subtitle}</div>}
        {d.methods && d.methods.length > 0 && (
          <div className="node-methods">
            {d.methods.map((m) => (
              <span
                key={m}
                className="node-method"
                onClick={(e) => { e.stopPropagation(); d.onMethodClick?.(m); }}
              >
                {m}
              </span>
            ))}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </>
  );
};

const nodeTypes = { swamp: SwampNode };

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

type Selection =
  | { kind: "model"; name: string }
  | { kind: "type"; type: string }
  | { kind: "workflow"; name: string }
  | { kind: "data"; model: string; name: string; version?: number }
  | null;

type TriggerState =
  | { kind: "workflow"; name: string; schema?: JsonSchema }
  | { kind: "method"; model: string; method: string; schema: JsonSchema }
  | null;

export default function App() {
  const [models, setModels] = React.useState<ModelSummary[]>([]);
  const [workflows, setWorkflows] = React.useState<WorkflowSummary[]>([]);
  const [typeCache, setTypeCache] = React.useState<Record<string, TypeDetail>>({});
  const [modelCache, setModelCache] = React.useState<Record<string, ModelDetail>>({});
  const [workflowCache, setWorkflowCache] = React.useState<Record<string, WorkflowDetail>>({});
  const [dataByModel, setDataByModel] = React.useState<Record<string, DataListResponse>>({});
  const [dataContent, setDataContent] = React.useState<Record<string, unknown>>({});
  const [selection, setSelection] = React.useState<Selection>(null);
  const [trigger, setTrigger] = React.useState<TriggerState>(null);
  const [toast, setToast] = React.useState<{ msg: string; isError?: boolean } | null>(null);
  const [repoDir, setRepoDir] = React.useState("");
  // nodes/edges are derived via useMemo from the caches + selection — never
  // stored as separate state, so we don't thrash ReactFlow's viewport on
  // every cache update.

  const showToast = (msg: string, isError?: boolean) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 4000);
  };

  // ---- initial load ----
  React.useEffect(() => {
    api.health().then((h) => setRepoDir(h.repoDir)).catch(() => {});
    refreshAll();
  }, []);

  // ---- initial load: fetch all summaries, then all details in parallel,
  // then set each cache ONCE. Avoids the per-fetch setState cascade that was
  // triggering ~18 graph rebuilds on startup. ----
  const refreshAll = async () => {
    try {
      const [m, w] = await Promise.all([api.listModels(), api.listWorkflows()]);
      setModels(m.results);
      setWorkflows(w.results);
      // Fetch all details in parallel.
      const [modelDetails, workflowDetails, typeDetails, dataLists] = await Promise.all([
        Promise.all(m.results.map((mod) => api.getModel(mod.name).catch(() => null))),
        Promise.all(w.results.map((wf) => api.getWorkflow(wf.name).catch(() => null))),
        // Types: dedupe by type string.
        Promise.all(Array.from(new Set(m.results.map((mod) => mod.type))).map((t) => api.getType(t).catch(() => null))),
        Promise.all(m.results.map((mod) => api.listData(mod.name).catch(() => null))),
      ]);
      const mc: Record<string, ModelDetail> = {};
      m.results.forEach((mod, i) => { const d = modelDetails[i]; if (d) mc[mod.name] = d; });
      setModelCache(mc);
      const wc: Record<string, WorkflowDetail> = {};
      w.results.forEach((wf, i) => { const d = workflowDetails[i]; if (d) wc[wf.name] = d; });
      setWorkflowCache(wc);
      const tc: Record<string, TypeDetail> = {};
      Array.from(new Set(m.results.map((mod) => mod.type))).forEach((t, i) => { const d = typeDetails[i]; if (d) tc[t] = d; });
      setTypeCache(tc);
      const dc: Record<string, DataListResponse> = {};
      m.results.forEach((mod, i) => { const d = dataLists[i]; if (d) dc[mod.name] = d; });
      setDataByModel(dc);
    } catch (err) {
      showToast(String(err), true);
    }
  };

  // ---- trigger workflow from sidebar / detail ----
  const triggerWorkflow = (name: string) => {
    // Workflow input schema isn't a JsonSchema in the detail; we use an empty
    // schema so the form shows "no inputs" — users pass raw key=value inputs
    // via a freeform JSON textarea below by extending this.
    setTrigger({ kind: "workflow", name, schema: EMPTY_SCHEMA });
  };

  const loaddataContent = async (model: string, name: string, version?: number) => {
    const key = `${model}:${name}:${version ?? "latest"}`;
    if (dataContent[key] !== undefined) return;
    try {
      const data = await api.getData(model, name, version);
      setDataContent((c) => ({ ...c, [key]: data }));
    } catch (err) {
      showToast(String(err), true);
    }
  };

  // Fetch data content when a data node is selected (top-level effect —
  // hooks must not be called conditionally inside renderDetail).
  React.useEffect(() => {
    if (selection?.kind === "data") {
      loaddataContent(selection.model, selection.name, selection.version);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  // ---- derive graph nodes/edges from caches. useMemo so we only rebuild
  // when the underlying data actually changes — not on every selection click
  // (selection only flips the `selected` flag, patched in below). ----
  const { nodes, edges } = React.useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];

    // Workflow nodes (left column)
    const wfX = 60;
    let wfY = 40;
    for (const wf of workflows) {
      const id = `wf:${wf.name}`;
      n.push({
        id,
        type: "swamp",
        position: { x: wfX, y: wfY },
        data: {
          kind: "workflow",
          title: wf.name,
          subtitle: `${wf.jobCount} job(s)`,
          selected: selection?.kind === "workflow" && selection.name === wf.name,
          onSelect: () => setSelection({ kind: "workflow", name: wf.name }),
        } as unknown as Node["data"],
      });
      wfY += 130;
    }

    // Model nodes (middle column)
    const modelX = 420;
    let modelY = 40;
    for (const m of models) {
      const id = `model:${m.name}`;
      const detail = modelCache[m.name];
      const methods = detail?.methods?.map((mm) => mm.name) || [];
      n.push({
        id,
        type: "swamp",
        position: { x: modelX, y: modelY },
        data: {
          kind: "model",
          title: m.name,
          subtitle: m.type,
          methods,
          selected: selection?.kind === "model" && selection.name === m.name,
          onSelect: () => setSelection({ kind: "model", name: m.name }),
          onMethodClick: (method: string) => {
            const methodSchema = detail?.methods.find((mm) => mm.name === method);
            if (methodSchema) {
              setTrigger({ kind: "method", model: m.name, method, schema: methodSchema.arguments });
            }
          },
        } as unknown as Node["data"],
      });
      modelY += 150;
    }

    // Type nodes (right of models)
    const typeX = 780;
    let typeY = 40;
    const seenTypes = new Set<string>();
    for (const m of models) {
      const t = m.type;
      if (seenTypes.has(t)) continue;
      seenTypes.add(t);
      const td = typeCache[t];
      const methods = td?.methods?.map((mm) => mm.name) || [];
      n.push({
        id: `type:${t}`,
        type: "swamp",
        position: { x: typeX, y: typeY },
        data: {
          kind: "type",
          title: t,
          subtitle: td ? `v${td.version}` : "",
          methods,
          selected: selection?.kind === "type" && selection.type === t,
          onSelect: () => setSelection({ kind: "type", type: t }),
        } as unknown as Node["data"],
      });
      typeY += 150;
    }

    // Data nodes (rightmost column) — only resource/file items, capped to
    // avoid the catalog's dozens of per-feed report items swamping the canvas.
    const dataX = 1120;
    let dataY = 40;
    for (const m of models) {
      const dl = dataByModel[m.name];
      if (!dl) continue;
      const items = dl.groups
        .flatMap((g) => g.items)
        .filter((i) => i.type === "resource" || i.type === "file");
      for (const item of items) {
        const id = `data:${m.name}:${item.name}`;
        n.push({
          id,
          type: "swamp",
          position: { x: dataX, y: dataY },
          data: {
            kind: "data",
            title: item.name,
            subtitle: `${m.name} · v${item.version}`,
            selected: selection?.kind === "data" && selection.model === m.name && selection.name === item.name,
            onSelect: () => setSelection({ kind: "data", model: m.name, name: item.name, version: item.version }),
          } as unknown as Node["data"],
        });
        dataY += 120;
      }
    }

    // Edges: workflow → model
    for (const wf of workflows) {
      const wfId = `wf:${wf.name}`;
      const detail = workflowCache[wf.name];
      if (!detail) continue;
      const seen = new Set<string>();
      for (const job of detail.jobs) {
        for (const step of job.steps) {
          const mn = step.task.modelName;
          if (!mn) continue;
          const edgeId = `e:${wfId}->model:${mn}:${step.name}`;
          if (seen.has(edgeId)) continue;
          seen.add(edgeId);
          e.push({
            id: edgeId,
            source: wfId,
            target: `model:${mn}`,
            className: "workflow-edge",
            animated: true,
          });
        }
      }
    }

    // Edges: model → type
    for (const m of models) {
      e.push({
        id: `e:model:${m.name}->type:${m.type}`,
        source: `model:${m.name}`,
        target: `type:${m.type}`,
      });
    }

    // Edges: model → data (produces)
    for (const m of models) {
      const dl = dataByModel[m.name];
      if (!dl) continue;
      const items = dl.groups
        .flatMap((g) => g.items)
        .filter((i) => i.type === "resource" || i.type === "file");
      for (const item of items) {
        e.push({
          id: `e:model:${m.name}->data:${m.name}:${item.name}`,
          source: `model:${m.name}`,
          target: `data:${m.name}:${item.name}`,
          className: "produces-edge",
        });
      }
    }

    return { nodes: n, edges: e };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, workflows, modelCache, workflowCache, typeCache, dataByModel, selection]);

  // ---- detail panel content ----
  const renderDetail = () => {
    if (!selection) {
      return <div style={{ color: "var(--muted)" }}>Select a node to see details.</div>;
    }
    if (selection.kind === "model") {
      const d = modelCache[selection.name];
      if (!d) return <div>Loading…</div>;
      return (
        <div>
          <h2>{d.name}</h2>
          <div className="row"><span className="k">Type</span><span className="v">{d.type}</span></div>
          <div className="row"><span className="k">Version</span><span className="v">{d.version}</span></div>
          <div className="row"><span className="k">Type version</span><span className="v">{d.typeVersion}</span></div>
          <div className="row"><span className="k">ID</span><span className="v">{d.id}</span></div>
          <h3>Methods</h3>
          {d.methods.map((m) => (
            <div className="method" key={m.name}>
              <div className="name">{m.name}</div>
              <div className="desc">{m.description}</div>
              <button onClick={() => setTrigger({ kind: "method", model: d.name, method: m.name, schema: m.arguments })}>
                Run {m.name}
              </button>
            </div>
          ))}
        </div>
      );
    }
    if (selection.kind === "type") {
      const t = typeCache[selection.type];
      if (!t) return <div>Loading…</div>;
      return (
        <div>
          <h2>{t.type.raw}</h2>
          <div className="row"><span className="k">Version</span><span className="v">{t.version}</span></div>
          <h3>Data outputs</h3>
          {t.dataOutputSpecs.map((s) => (
            <div className="method" key={s.specName}>
              <div className="name">{s.specName}</div>
              <div className="desc">{s.description}</div>
              <div className="row"><span className="k">kind</span><span className="v">{s.kind}</span></div>
              <div className="row"><span className="k">lifetime</span><span className="v">{s.lifetime}</span></div>
              <div className="row"><span className="k">GC</span><span className="v">{s.garbageCollection}</span></div>
            </div>
          ))}
          <h3>Methods</h3>
          {t.methods.map((m) => (
            <div className="method" key={m.name}>
              <div className="name">{m.name}</div>
              <div className="desc">{m.description}</div>
            </div>
          ))}
        </div>
      );
    }
    if (selection.kind === "workflow") {
      const w = workflowCache[selection.name];
      if (!w) return <div>Loading…</div>;
      return (
        <div>
          <h2>{w.name}</h2>
          <div className="row"><span className="k">Version</span><span className="v">{w.version}</span></div>
          <div className="row"><span className="k">ID</span><span className="v">{w.id}</span></div>
          <p style={{ color: "var(--muted)", whiteSpace: "pre-wrap" }}>{w.description}</p>
          <button className="primary" onClick={() => triggerWorkflow(w.name)}>Run workflow</button>
          <h3>Jobs</h3>
          {w.jobs.map((job) => (
            <div key={job.name}>
              <div style={{ fontWeight: 600 }}>{job.name}</div>
              {job.steps.map((step) => <StepView key={step.name} step={step} />)}
            </div>
          ))}
        </div>
      );
    }
    if (selection.kind === "data") {
      const key = `${selection.model}:${selection.name}:${selection.version ?? "latest"}`;
      const content = dataContent[key] as Record<string, unknown> | undefined;
      const dl = dataByModel[selection.model];
      const item = dl?.groups.flatMap((g) => g.items).find((i) => i.name === selection.name);
      return (
        <div>
          <h2>{selection.name}</h2>
          <div className="row"><span className="k">Model</span><span className="v">{selection.model}</span></div>
          {item && (
            <>
              <div className="row"><span className="k">Version</span><span className="v">{item.version}</span></div>
              <div className="row"><span className="k">Type</span><span className="v">{item.type}</span></div>
              <div className="row"><span className="k">Content-Type</span><span className="v">{item.contentType}</span></div>
              <div className="row"><span className="k">Size</span><span className="v">{item.size} bytes</span></div>
              <div className="row"><span className="k">Created</span><span className="v">{item.createdAt}</span></div>
            </>
          )}
          <h3>Content</h3>
          {content === undefined ? (
            <div>Loading…</div>
          ) : (
            <DataTable title="content" value={(content as { content?: unknown }).content ?? content} />
          )}
          <h3>Metadata</h3>
          {content === undefined ? (
            <div>Loading…</div>
          ) : (
            <DataTable
              title="metadata"
              value={stripContent(content)}
            />
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="layout">
      <div className="topbar">
        <h1>Swamp Explorer</h1>
        <span className="repo">{repoDir}</span>
        <span className="spacer" />
        <button onClick={refreshAll}>Refresh</button>
      </div>

      <div className="sidebar">
        <h2>Workflows</h2>
        <ul>
          {workflows.map((w) => (
            <li
              key={w.name}
              className={selection?.kind === "workflow" && selection.name === w.name ? "active" : ""}
              onClick={() => setSelection({ kind: "workflow", name: w.name })}
            >
              <span>{w.name}</span>
              <span className="badge">▶</span>
            </li>
          ))}
        </ul>
        <h2>Models</h2>
        <ul>
          {models.map((m) => (
            <li
              key={m.name}
              className={selection?.kind === "model" && selection.name === m.name ? "active" : ""}
              onClick={() => setSelection({ kind: "model", name: m.name })}
            >
              <span>{m.name}</span>
              <span className="badge">{m.type.split("/").pop()}</span>
            </li>
          ))}
        </ul>
        <h2>Types</h2>
        <ul>
          {Object.keys(typeCache).map((t) => (
            <li
              key={t}
              className={selection?.kind === "type" && selection.type === t ? "active" : ""}
              onClick={() => setSelection({ kind: "type", type: t })}
            >
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e2533" />
          <Controls />
          <MiniMap
            nodeColor={(n) => {
              const d = n.data as unknown as NodeData;
              if (d?.kind === "workflow") return "var(--accent-2)";
              if (d?.kind === "model") return "var(--accent)";
              if (d?.kind === "data") return "var(--green)";
              return "var(--orange)";
            }}
          />
        </ReactFlow>
      </div>

      <div className="detail">
        {renderDetail()}
      </div>

      {trigger && (
        <TriggerDialog
          trigger={trigger}
          onClose={() => setTrigger(null)}
          onDone={(msg, err) => showToast(msg, err)}
        />
      )}

      {toast && (
        <div className={`toast ${toast.isError ? "error" : "success"}`}>{toast.msg}</div>
      )}
    </div>
  );
}

const EMPTY_SCHEMA: JsonSchema = { type: "object", properties: {} };

function StepView({ step }: { step: WorkflowStep }) {
  return (
    <div className="method">
      <div className="name">{step.name}</div>
      {step.description && <div className="desc">{step.description}</div>}
      <div className="row"><span className="k">task</span><span className="v">{step.task.type}</span></div>
      {step.task.modelType && <div className="row"><span className="k">modelType</span><span className="v">{step.task.modelType}</span></div>}
      {step.task.modelName && <div className="row"><span className="k">modelName</span><span className="v">{step.task.modelName}</span></div>}
      {step.task.methodName && <div className="row"><span className="k">method</span><span className="v">{step.task.methodName}</span></div>}
      {step.task.inputs && (
        <>
          <div className="row"><span className="k">inputs</span></div>
          <pre>{JSON.stringify(step.task.inputs, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DataTable — renders a value as a table. For arrays of objects, renders a
// proper HTML table with columns from the union of keys. For other shapes,
// falls back to a two-column key/value table. Shows a count badge.
// ---------------------------------------------------------------------------

function DataTable({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) {
    return <div className="data-table-empty">—</div>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="data-table-meta">{title}: 0 rows</div>;
    // If it's an array of objects, render a proper table.
    if (typeof value[0] === "object" && value[0] !== null) {
      const cols = collectColumns(value as Record<string, unknown>[]);
      return (
        <div className="data-table-wrap">
          <div className="data-table-meta">{title}: {value.length} rows × {cols.length} columns</div>
          <div className="data-table-scroll">
            <table className="data-table">
              <thead>
                <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {value.map((row, i) => (
                  <tr key={i}>
                    {cols.map((c) => <td key={c}>{renderCell((row as Record<string, unknown>)[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    // Array of scalars — single-column table.
    return (
      <div className="data-table-wrap">
        <div className="data-table-meta">{title}: {value.length} items</div>
        <div className="data-table-scroll">
          <table className="data-table">
            <tbody>
              {value.map((v, i) => <tr key={i}><td>{renderCell(v)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <div className="data-table-meta">{title}: empty</div>;
    return (
      <div className="data-table-wrap">
        <div className="data-table-meta">{title}: {entries.length} fields</div>
        <div className="data-table-scroll">
          <table className="data-table kv-table">
            <tbody>
              {entries.map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{renderCell(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  // scalar
  return (
    <div className="data-table-wrap">
      <div className="data-table-meta">{title}</div>
      <div className="data-table-scroll">
        <table className="data-table">
          <tbody><tr><td>{String(value)}</td></tr></tbody>
        </table>
      </div>
    </div>
  );
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

function renderCell(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span style={{ color: "var(--muted)" }}>—</span>;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const display = v.length > 80 ? v.slice(0, 80) + "…" : v;
    // URLs rendered as links
    if (/^https?:\/\//.test(v)) {
      return <a href={v} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{display}</a>;
    }
    return display;
  }
  if (Array.isArray(v)) {
    return <InlineArray value={v} />;
  }
  if (typeof v === "object") {
    return <InlineObject value={v as Record<string, unknown>} />;
  }
  return String(v);
}

// Inline expandable nested values — used inside table cells.
function InlineArray({ value }: { value: unknown[] }) {
  const [open, setOpen] = React.useState(false);
  const summary = `[${value.length} items]`;
  if (value.length === 0) return <span style={{ color: "var(--muted)" }}>{summary}</span>;
  // Array of objects → keys as columns, one row per item
  if (typeof value[0] === "object" && value[0] !== null && !Array.isArray(value[0])) {
    const cols = collectColumns(value as Record<string, unknown>[]);
    return (
      <div className="inline-expandable">
        <span className="inline-toggle" onClick={() => setOpen(!open)}>
          <span className="inline-arrow">{open ? "▾" : "▸"}</span>
          <span style={{ color: "var(--muted)" }}>{summary}</span>
        </span>
        {open && (
          <div className="data-table-scroll inline-table">
            <table className="data-table">
              <thead>
                <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {value.map((row, i) => (
                  <tr key={i}>
                    {cols.map((c) => <td key={c}>{renderCell((row as Record<string, unknown>)[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }
  // Array of scalars / arrays — vertical list
  return (
    <div className="inline-expandable">
      <span className="inline-toggle" onClick={() => setOpen(!open)}>
        <span className="inline-arrow">{open ? "▾" : "▸"}</span>
        <span style={{ color: "var(--muted)" }}>{summary}</span>
      </span>
      {open && (
        <ul className="inline-list">
          {value.map((v, i) => <li key={i}>{renderCell(v)}</li>)}
        </ul>
      )}
    </div>
  );
}

function InlineObject({ value }: { value: Record<string, unknown> }) {
  const [open, setOpen] = React.useState(false);
  const keys = Object.keys(value);
  const summary = `{${keys.length} fields}`;
  if (keys.length === 0) return <span style={{ color: "var(--muted)" }}>{summary}</span>;
  return (
    <div className="inline-expandable">
      <span className="inline-toggle" onClick={() => setOpen(!open)}>
        <span className="inline-arrow">{open ? "▾" : "▸"}</span>
        <span style={{ color: "var(--muted)" }}>{summary}</span>
      </span>
      {open && (
        <div className="data-table-scroll inline-table">
          <table className="data-table kv-table">
            <tbody>
              {Object.entries(value).map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{renderCell(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function stripContent(obj: Record<string, unknown>): Record<string, unknown> {
  const { content: _content, ...rest } = obj;
  return rest;
}