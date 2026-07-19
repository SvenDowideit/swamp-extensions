import React from "react";

// Minimal recursive JSON viewer with collapsible nodes.
export function JsonViewer({ data }: { data: unknown }) {
  return <div className="json-viewer"><Node value={data} name={null} depth={0} /></div>;
}

function Node({ value, name, depth }: { value: unknown; name: string | null; depth: number }) {
  const [open, setOpen] = React.useState(depth < 2);
  const indent = { marginLeft: depth * 12 };

  if (value === null) {
    return <Line name={name} indent={indent}><span style={{ color: "var(--muted)" }}>null</span></Line>;
  }
  if (typeof value === "boolean") {
    return <Line name={name} indent={indent}><span style={{ color: "var(--orange)" }}>{String(value)}</span></Line>;
  }
  if (typeof value === "number") {
    return <Line name={name} indent={indent}><span style={{ color: "var(--accent-2)" }}>{value}</span></Line>;
  }
  if (typeof value === "string") {
    const display = value.length > 200 ? value.slice(0, 200) + "…" : value;
    return <Line name={name} indent={indent}><span style={{ color: "var(--green)" }}>"{display}"</span></Line>;
  }
  if (Array.isArray(value)) {
    return (
      <div>
        <Line name={name} indent={indent}>
          <Toggle open={open} onClick={() => setOpen(!open)} />
          <span style={{ color: "var(--muted)" }}>[{value.length}]</span>
        </Line>
        {open && value.map((v, i) => <Node key={i} value={v} name={String(i)} depth={depth + 1} />)}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div>
        <Line name={name} indent={indent}>
          <Toggle open={open} onClick={() => setOpen(!open)} />
          <span style={{ color: "var(--muted)" }}>{`{${entries.length}}`}</span>
        </Line>
        {open && entries.map(([k, v]) => <Node key={k} value={v} name={k} depth={depth + 1} />)}
      </div>
    );
  }
  return <Line name={name} indent={indent}>{String(value)}</Line>;
}

function Line({ name, indent, children }: { name: string | null; indent: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div style={indent}>
      {name !== null && <span style={{ color: "var(--accent)" }}>{name}: </span>}
      {children}
    </div>
  );
}

function Toggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ cursor: "pointer", color: "var(--muted)", marginRight: 2, userSelect: "none", display: "inline-block", width: 12 }}
    >
      {open ? "▾" : "▸"}
    </span>
  );
}