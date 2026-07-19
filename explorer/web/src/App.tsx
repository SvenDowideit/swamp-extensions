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
  const [nodes, setNodes] = React.useState<Node[]>([]);
  const [edges, setEdges] = React.useState<Edge[]>([]);
  const [repoDir, setRepoDir] = React.useState("");

  const showToast = (msg: string, isError?: boolean) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 4000);
  };

  // ---- initial load ----
  React.useEffect(() => {
    api.health().then((h) => setRepoDir(h.repoDir)).catch(() => {});
    refreshAll();
  }, []);

  const refreshAll = async () => {
    try {
      const [m, w] = await Promise.all([api.listModels(), api.listWorkflows()]);
      setModels(m.results);
      setWorkflows(w.results);
      // Pre-load type + model detail + data list for every model, and workflow detail.
      await Promise.all([
        ...m.results.map((mod) => loadModelDetail(mod.name)),
        ...w.results.map((wf) => loadWorkflowDetail(wf.name)),
      ]);
      // Build graph after detail is loaded.
    } catch (err) {
      showToast(String(err), true);
    }
  };

  const loadModelDetail = async (name: string) => {
    if (modelCache[name]) return modelCache[name];
    try {
      const detail = await api.getModel(name);
      setModelCache((c) => ({ ...c, [name]: detail }));
      // Also cache the type
      if (!typeCache[detail.type]) {
        try {
          const t = await api.getType(detail.type);
          setTypeCache((c) => ({ ...c, [detail.type]: t }));
        } catch { /* ignore */ }
      }
      // And the data list
      try {
        const dl = await api.listData(name);
        setDataByModel((c) => ({ ...c, [name]: dl }));
      } catch { /* ignore */ }
      return detail;
    } catch (err) {
      showToast(String(err), true);
    }
  };

  const loadWorkflowDetail = async (name: string) => {
    if (workflowCache[name]) return workflowCache[name];
    try {
      const detail = await api.getWorkflow(name);
      setWorkflowCache((c) => ({ ...c, [name]: detail }));
      return detail;
    } catch (err) {
      showToast(String(err), true);
    }
  };

  // ---- rebuild graph whenever caches change ----
  React.useEffect(() => {
    buildGraph();
  }, [modelCache, workflowCache, typeCache, dataByModel, selection]);

  const buildGraph = () => {
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

    // Model nodes (middle column) — group by type
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
    const typeNodes: Record<string, string> = {};
    for (const m of models) {
      const t = m.type;
      if (typeNodes[t]) continue;
      typeNodes[t] = `type:${t}`;
      const td = typeCache[t];
      const methods = td?.methods?.map((mm) => mm.name) || [];
      n.push({
        id: typeNodes[t],
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

    // Data nodes (rightmost column) — one per (model, data-name) for the catalog resources.
    const dataX = 1120;
    let dataY = 40;
    const dataNodeIds: Record<string, string> = {};
    for (const m of models) {
      const dl = dataByModel[m.name];
      if (!dl) continue;
      // Only show the top "resource" type items (catalog current/list-output) to avoid spam.
      const items = dl.groups.flatMap((g) => g.items).filter((i) => i.type === "resource" || i.type === "file");
      for (const item of items) {
        const id = `data:${m.name}:${item.name}`;
        dataNodeIds[`${m.name}:${item.name}`] = id;
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

    // Edges: workflow → model (each step's modelName)
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
      const items = dl.groups.flatMap((g) => g.items).filter((i) => i.type === "resource" || i.type === "file");
      for (const item of items) {
        e.push({
          id: `e:model:${m.name}->data:${m.name}:${item.name}`,
          source: `model:${m.name}`,
          target: `data:${m.name}:${item.name}`,
          className: "produces-edge",
        });
      }
    }

    setNodes(n);
    setEdges(e);
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
      const content = dataContent[key];
      const dl = dataByModel[selection.model];
      const item = dl?.groups.flatMap((g) => g.items).find((i) => i.name === selection.name);
      React.useEffect(() => { loaddataContent(selection.model, selection.name, selection.version); }, [key]);
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
          {content === undefined ? <div>Loading…</div> : <JsonViewer data={content} />}
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