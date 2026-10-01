package ui

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// Pane identifies one of the browsing columns.
type Pane int

const (
	PaneWorkflows Pane = iota
	PaneModels
	PaneDetail
	PaneData
	PaneCount // sentinel
)

func (p Pane) Title() string {
	switch p {
	case PaneWorkflows:
		return "Workflows"
	case PaneModels:
		return "Models"
	case PaneDetail:
		return "Detail"
	case PaneData:
		return "Data"
	}
	return "?"
}

// RootKind selects which class of object the Detail and Data panes describe.
type RootKind int

const (
	RootWorkflow RootKind = iota
	RootModel
)

// node is a selectable row in a pane.
type node struct {
	label string
	sub   string
	kind  string
}

// runOutput is one artifact produced by a run step: model data (resource),
// a report, or a file such as rendered HTML.
type runOutput struct {
	step        string
	kind        string // "resource" | "report" | "file"
	name        string
	modelName   string
	version     int
	reportName  string
	contentType string
}

// recentRun is one entry in a workflow's recent-runs list, with the outputs it
// produced so they can be browsed directly from the Detail pane.
type recentRun struct {
	runID          string
	status         string
	startedAt      string
	durationMS     int64
	stepsCompleted int
	stepsTotal     int
	failedStep     string
	outputs        []runOutput
}

// detailLink is a selectable row inside the Detail pane (a run output bullet).
// line indexes into detailLines; plain is the unstyled row text used to redraw
// it when selected.
type detailLink struct {
	line     int
	plain    string
	artifact runOutput
	runID    string
}

// Model holds the whole TUI state. It is the bubbletea Model.
type Model struct {
	client *swamp.Client
	repo   string
	serve  *swamp.Serve // nil if attached to an existing server

	width, height int
	focus         Pane

	// Pane data
	workflows    []node
	wfSel        int
	models       []node
	modelSel     int
	detailLines  []string
	detailTitle  string
	detailScroll int
	dataItems    []node
	dataRefs     []runOutput // parallel to dataItems: refs for the inspector
	dataSel      int

	// rootKind/rootName identify the object the Detail and Data panes describe
	// (the selected workflow or model). rootInputs holds the root's declared
	// workflow inputs schema, used to build the run form.
	rootKind   RootKind
	rootName   string
	rootInputs map[string]any

	// Run console: an overlay that streams a workflow run's events.
	runOpen   bool
	runTitle  string
	runStatus string
	runID     string
	runLines  []string
	runScroll int
	runErr    error
	runHandle *swamp.RunHandle
	runBusy   bool

	// runUnseen is set when a run reaches a terminal state while the dialog is
	// closed, so the header can flag a result the user has not looked at yet.
	runUnseen bool

	// quitConfirm is shown when quitting while a run is still active, so the
	// user can choose whether the run (and an owned serve) keeps running.
	quitConfirm bool

	// lastRunID/lastFailedStep describe the most recent run of the current
	// workflow root, enabling resume-at-step.
	lastRunID      string
	lastFailedStep string

	// recentRuns backs the interactive "recent runs" list in the Detail pane,
	// including each run's data/report/file outputs.
	recentRuns []recentRun

	// detailLinks are the selectable run-output rows within detailLines, and
	// detailSel is the chosen one (-1 when none).
	detailLinks []detailLink
	detailSel   int

	// Artifact viewer dialog: shows the content of one run output. For JSON
	// artifacts, viewNames holds the applicable contextual views (forecast,
	// bars, table, fields, json) and viewIdx selects the active one.
	viewOpen     bool
	viewTitle    string
	viewKind     string // "html" | "markdown" | "json" | "text"
	viewLines    []string
	viewScroll   int
	viewLoading  bool
	viewErr      error
	viewArtifact runOutput
	viewRunID    string
	viewNames    []string            // contextual view names, or nil
	viewIdx      int                 // index into viewNames
	viewCache    map[string][]string // rendered lines per view name

	// Run input form (shown before starting a run that declares inputs).
	inputOpen    bool
	inputFields  []runField
	inputSel     int
	inputEditing bool

	loading      bool
	status       string
	err          error
	wfLoaded     bool
	modelLoaded  bool
	bootstrapped bool

	// filter is a live substring filter applied to the focused list pane.
	filtering bool
	filter    string

	// pendingData names a data item to select once the root's detail loads
	// (used by spotter jumps).
	pendingData string

	// spotter is the global search overlay.
	spotterOpen    bool
	spotterQuery   string
	spotterIndex   []spotterItem // all items, unfiltered
	spotterResults []spotterItem // current matches
	spotterSel     int
	spotterLoaded  bool

	// Playground is the CEL query console: a predicate and optional select,
	// evaluated with data.query over the data catalog.
	pgOpen    bool
	pgPred    string
	pgSelect  string
	pgField   int // 0 = predicate, 1 = select
	pgEditing bool
	pgLoading bool
	pgErr     error
	pgResult  *swamp.QueryResult
	pgRows    []runOutput // selectable data refs for record results
	pgRowSel  int
	pgScroll  int
	pgHistory []pgQuery
	pgHistIdx int // -1 when not browsing history

	// pgHelp shows the in-window cheat-sheet and runnable examples instead of
	// results. It starts visible so the console is self-teaching, and hides
	// once a query runs (toggle any time with ?). pgHelpScroll is its own
	// scroll offset, so opening shows the docs from the top.
	pgHelp       bool
	pgHelpSel    int
	pgHelpScroll int
	pgHelpOff    bool // user explicitly dismissed help for this session

	// Vault mode: a full-screen overlay for browsing, viewing, editing and
	// creating vaults and their secrets.
	vault vaultState
}

// vaultFocus identifies which pane of Vault mode has the keyboard.
type vaultFocus int

const (
	VaultFocusTree vaultFocus = iota
	VaultFocusDetail
)

// VaultRow is one selectable row in the left tree. A row is either a vault
// extension (a backend type, with installed vaults nested under it) or a
// configured vault.
type VaultRow struct {
	kind     string // "extension" | "vault"
	name     string // extension type or vault name
	typeName string // display name for an extension (or vault type)
	sub      string
	depth    int // 0 = extension, 1 = vault under its extension
	vault    swamp.Vault
}

// vaultState holds all Vault-mode UI state.
type vaultState struct {
	open  bool
	focus vaultFocus

	// Left tree.
	rows    []VaultRow
	sel     int
	loading bool
	err     error

	// Right pane contents, keyed by what the selected row is.
	detailLines []string
	detailTitle string
	detailKind  string // "extension" | "vault" | "key" | "audit"
	detailScrol int

	// When a vault is selected: its secret keys as a table.
	keys     []string
	keyMeta  map[string]swamp.VaultKeyMeta
	keySel   int
	pendingK int // key index to select once keys load

	// Reveal state for a secret value.
	revealedKey   string
	revealedValue string

	// Audit trail (loaded on demand).
	audit      []swamp.VaultAuditEntry
	auditShown bool

	// Prompt overlay (single-line text entry for put/annotate/create/etc.).
	promptOpen    bool
	promptTitle   string
	promptLabel   string
	promptValue   string
	promptKind    string // what the prompt will do on submit
	promptVault   string
	promptKey     string
	promptRefresh string // optional refresh-from (for put)

	// Confirm overlay (yes/no for delete).
	confirmOpen  bool
	confirmTitle string
	confirmBody  string
	confirmKind  string
	confirmVault string
	confirmKey   string

	// Transient status line inside vault mode.
	status  string
	busy    bool
	extInfo map[string]any // extension.info (registry) for the selected extension

	// installed maps extension name -> the version/channel pulled into this
	// repo (from extension.list). This is authoritative for what is active;
	// extInfo describes the registry's latest release, which may differ.
	installed map[string]swamp.Extension
}

// vaultRowGlyph is the leading marker for a tree row.
func vaultRowGlyph(r VaultRow) string {
	if r.kind == "extension" {
		return "▣"
	}
	return "•"
}

// pgQuery is one entry in the Playground query history.

// pgQuery is one entry in the Playground query history.
type pgQuery struct {
	pred       string
	selectExpr string
}

// New builds the initial model.
func New(client *swamp.Client, repo string, serve *swamp.Serve) *Model {
	return &Model{
		client: client,
		repo:   repo,
		serve:  serve,
		focus:  PaneModels,
		status: "connecting…",
	}
}

// spotterItem is one row in the global search overlay.
type spotterItem struct {
	kind  string // "model" | "workflow" | "data"
	label string
	sub   string
	// payload for navigation
	model string // model name (models, data)
	data  string // data name (data)
}

// spotterLoadedMsg delivers the assembled global search index.
type spotterLoadedMsg struct {
	models    []spotterItem
	workflows []spotterItem
	data      []spotterItem
	err       error
}

// loadSpotter builds the global index: models, workflows, and the data catalog.
func (m *Model) loadSpotter() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()

		var out spotterLoadedMsg

		if res, err := client.SearchModels(ctx, ""); err == nil {
			for _, r := range asList(res["results"]) {
				obj, ok := r.(map[string]any)
				if !ok {
					continue
				}
				out.models = append(out.models, spotterItem{
					kind: "model", label: str(obj["name"]), sub: str(obj["type"]),
					model: str(obj["name"]),
				})
			}
		} else {
			out.err = err
		}

		if res, err := client.SearchWorkflows(ctx, ""); err == nil {
			for _, r := range asList(res["results"]) {
				obj, ok := r.(map[string]any)
				if !ok {
					continue
				}
				out.workflows = append(out.workflows, spotterItem{
					kind: "workflow", label: str(obj["name"]),
					sub: joinNonEmpty(" · ",
						fmt.Sprintf("%v jobs", obj["jobCount"]),
						fmt.Sprintf("%v steps", obj["stepCount"])),
				})
			}
		}

		// Data catalog: one projected row per data item.
		if rows, err := client.DataQuery(ctx,
			`size >= 0`, `[modelName, name, string(version), dataType, string(size)]`, 2000); err == nil {
			for _, r := range rows {
				cols, ok := r.([]any)
				if !ok || len(cols) < 4 {
					continue
				}
				model, name, ver, typ := str(cols[0]), str(cols[1]), str(cols[2]), str(cols[3])
				sub := typ + " v" + ver
				if len(cols) >= 5 {
					sub += "  " + humanSize(stringToFloat(cols[4]))
				}
				out.data = append(out.data, spotterItem{
					kind: "data", label: name, sub: sub, model: model, data: name,
				})
			}
		}

		return out
	}
}

// stringToFloat parses a numeric string produced by a CEL string() projection.
func stringToFloat(v any) any {
	if s, ok := v.(string); ok {
		var f float64
		if _, err := fmt.Sscanf(s, "%g", &f); err == nil {
			return f
		}
	}
	return v
}

// --- async messages ---

type modelsLoadedMsg struct {
	models []node
	err    error
}

type detailLoadedMsg struct {
	title          string
	lines          []string
	items          []node
	refs           []runOutput
	links          []detailLink
	runs           []recentRun
	err            error
	root           RootKind
	name           string
	inputs         map[string]any
	lastRunID      string
	lastFailedStep string
}

type workflowsLoadedMsg struct {
	workflows []node
	err       error
}

// --- commands ---

func (m *Model) loadModels() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		res, err := client.SearchModels(ctx, "")
		if err != nil {
			return modelsLoadedMsg{err: err}
		}
		results := asList(res["results"])
		models := make([]node, 0, len(results))
		for _, r := range results {
			obj, ok := r.(map[string]any)
			if !ok {
				continue
			}
			name := str(obj["name"])
			if name == "" {
				continue
			}
			models = append(models, node{label: name, sub: str(obj["type"]), kind: "model"})
		}
		sort.Slice(models, func(i, j int) bool { return models[i].label < models[j].label })
		return modelsLoadedMsg{models: models}
	}
}

func (m *Model) loadWorkflows() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		res, err := client.SearchWorkflows(ctx, "")
		if err != nil {
			return workflowsLoadedMsg{err: err}
		}
		results := asList(res["results"])
		wfs := make([]node, 0, len(results))
		for _, r := range results {
			obj, ok := r.(map[string]any)
			if !ok {
				continue
			}
			name := str(obj["name"])
			if name == "" {
				continue
			}
			wfs = append(wfs, node{
				label: name,
				sub: joinNonEmpty(" · ",
					fmt.Sprintf("%v jobs", obj["jobCount"]),
					fmt.Sprintf("%v steps", obj["stepCount"])),
				kind: "workflow",
			})
		}
		sort.Slice(wfs, func(i, j int) bool { return wfs[i].label < wfs[j].label })
		return workflowsLoadedMsg{workflows: wfs}
	}
}

// selectWorkflow loads a workflow's detail (its job/step DAG) and workflow data.
func (m *Model) selectWorkflow() tea.Cmd {
	wfs := m.visibleWorkflows()
	if len(wfs) == 0 {
		return nil
	}
	sel := wfs[clamp(m.wfSel, 0, len(wfs)-1)]
	name := sel.label
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		wf, err := client.GetWorkflow(ctx, name)
		if err != nil {
			return detailLoadedMsg{
				title: name, root: RootWorkflow, name: name,
				lines: []string{styleError.Render("workflow.get: " + err.Error())},
				err:   err,
			}
		}
		lines := renderWorkflowDetail(wf)

		var inputs map[string]any
		if in, ok := wf["inputs"].(map[string]any); ok {
			inputs = in
		}
		var lastRunID, lastFailedStep string
		var runs []recentRun
		var links []detailLink

		if entries, err := client.SearchWorkflowRuns(ctx, name, 8); err == nil && len(entries) > 0 {
			lastRunID = entries[0].RunID
			lastFailedStep = entries[0].FailedStep
			lines = append(lines, "", stylePaneTitle.Render(fmt.Sprintf("Recent runs (%d)", len(entries))))
			for _, r := range entries {
				rr := recentRun{
					runID:          r.RunID,
					status:         r.Status,
					startedAt:      r.StartedAt,
					durationMS:     r.DurationMS,
					stepsCompleted: r.StepsCompleted,
					stepsTotal:     r.StepsTotal,
					failedStep:     r.FailedStep,
				}
				// Per-run outputs come from the history record; it is the only
				// source that links a run to the data/files/reports it made.
				if det, err := client.GetWorkflowRun(ctx, r.RunID); err == nil {
					rr.outputs = outputsFromRun(det)
				}
				runs = append(runs, rr)

				dot := styleGreen.Render("●")
				if r.Status != "succeeded" {
					dot = styleError.Render("●")
				}
				when := r.StartedAt
				if len(when) >= 16 {
					when = when[5:16] // MM-DDTHH:MM
				}
				lines = append(lines, fmt.Sprintf("  %s %-9s %s  %d/%d steps  %dms",
					dot, r.Status, when, r.StepsCompleted, r.StepsTotal, r.DurationMS))
				if r.FailedStep != "" {
					lines = append(lines, "      "+styleError.Render("failed at "+r.FailedStep))
				}
				const maxOutputsPerRun = 25
				shown := rr.outputs
				if len(shown) > maxOutputsPerRun {
					shown = shown[:maxOutputsPerRun]
				}
				for _, o := range shown {
					plain := "      " + runOutputGlyph(o) + " " + runOutputLabel(o)
					links = append(links, detailLink{
						line: len(lines), plain: plain, artifact: o, runID: r.RunID,
					})
					lines = append(lines, styleMuted.Render(plain))
				}
				if extra := len(rr.outputs) - len(shown); extra > 0 {
					lines = append(lines, styleMuted.Render(
						fmt.Sprintf("      … %d more outputs", extra)))
				}
			}
		}

		items, refs := workflowDataItems(ctx, client, name)
		return detailLoadedMsg{
			title: name, root: RootWorkflow, name: name,
			lines: lines, items: items, refs: refs, inputs: inputs, links: links, runs: runs,
			lastRunID: lastRunID, lastFailedStep: lastFailedStep,
		}
	}
}

// outputsFromRun flattens a run's per-step artifacts into runOutput, tagging
// each with the step that produced it and de-duplicating the JSON mirror of a
// report (report-*-json) so the list stays readable.
func outputsFromRun(det *swamp.RunDetail) []runOutput {
	var out []runOutput
	seen := map[string]bool{}
	for _, s := range det.Steps {
		for _, a := range s.Artifacts {
			// Skip the machine-readable JSON twin of a report; the markdown
			// is what a human wants to read.
			if a.Kind == "report" && strings.HasSuffix(a.Name, "-json") {
				continue
			}
			key := a.ModelName + "/" + a.Name + "/" + strconv.Itoa(a.Version)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, runOutput{
				step:        s.Name,
				kind:        a.Kind,
				name:        a.Name,
				modelName:   a.ModelName,
				version:     a.Version,
				reportName:  a.ReportName,
				contentType: a.ContentType,
			})
		}
	}
	return out
}

// runOutputGlyph is the leading marker for an output bullet by kind.
func runOutputGlyph(o runOutput) string {
	switch o.kind {
	case "report":
		return "▤"
	case "file":
		return "◫"
	default:
		return "◆"
	}
}

// runOutputLabel is the human label for a run output row.
func runOutputLabel(o runOutput) string {
	name := o.name
	if o.kind == "report" && o.reportName != "" {
		name = "report " + o.reportName
	}
	detail := o.kind
	if o.modelName != "" {
		detail = o.modelName
	}
	if o.version > 0 {
		detail += " v" + strconv.Itoa(o.version)
	}
	if o.step != "" {
		detail = o.step + " · " + detail
	}
	return fmt.Sprintf("%s  [%s]", name, detail)
}

// dataItem pairs a display node with the ref needed to open it in the
// contextual inspector. The two slices are always built and sorted together.
type dataItem struct {
	node node
	ref  runOutput
}

// workflowDataItems loads data produced by a workflow, flattened into nodes,
// plus parallel refs for the contextual inspector (same order).
func workflowDataItems(ctx context.Context, client *swamp.Client, name string) ([]node, []runOutput) {
	var items []dataItem
	dl, err := client.ListWorkflowData(ctx, name)
	if err != nil {
		return nil, nil
	}
	for _, grp := range asList(dl["groups"]) {
		gm, ok := grp.(map[string]any)
		if !ok {
			continue
		}
		for _, it := range asList(gm["items"]) {
			im, ok := it.(map[string]any)
			if !ok {
				continue
			}
			sub := str(im["type"]) + " v" + str(im["version"]) + "  " + humanSize(im["size"])
			if step := str(im["stepName"]); step != "" {
				sub = step + " · " + sub
			}
			items = append(items, dataItem{
				node: node{label: str(im["name"]), sub: sub, kind: "data"},
				ref: runOutput{
					name:        str(im["name"]),
					modelName:   str(im["modelName"]),
					version:     int(numVal(im["version"])),
					contentType: str(im["contentType"]),
					kind:        str(im["type"]),
				},
			})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].node.label < items[j].node.label })
	nodes := make([]node, len(items))
	refs := make([]runOutput, len(items))
	for i, it := range items {
		nodes[i], refs[i] = it.node, it.ref
	}
	return nodes, refs
}

// renderWorkflowDetail formats a workflow.get payload into display lines,
// showing jobs and their step dependency edges as a simple DAG.
func renderWorkflowDetail(wf map[string]any) []string {
	lines := []string{styleKey.Render("name ") + str(wf["name"])}
	if d := str(wf["description"]); d != "" {
		lines = append(lines, "")
		for _, ln := range strings.Split(strings.TrimRight(d, "\n"), "\n") {
			lines = append(lines, styleMuted.Render(ln))
		}
	}

	// Declared inputs.
	if inputs, ok := wf["inputs"].(map[string]any); ok {
		props, _ := inputs["properties"].(map[string]any)
		if len(props) > 0 {
			keys := make([]string, 0, len(props))
			for k := range props {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			lines = append(lines, "", stylePaneTitle.Render("Inputs"))
			for _, k := range keys {
				pm, _ := props[k].(map[string]any)
				req := ""
				for _, r := range asList(inputs["required"]) {
					if str(r) == k {
						req = " *"
					}
				}
				lines = append(lines, "  "+styleKey.Render(k)+req+
					styleMuted.Render("  "+str(pm["type"])+"  "+firstLine(str(pm["description"]))))
			}
		}
	}

	jobs := asList(wf["jobs"])
	lines = append(lines, "", stylePaneTitle.Render(fmt.Sprintf("Jobs (%d)", len(jobs))))
	for _, j := range jobs {
		jm, ok := j.(map[string]any)
		if !ok {
			continue
		}
		lines = append(lines, "  "+styleKind.Render("▸ "+str(jm["name"])))
		if d := str(jm["description"]); d != "" {
			lines = append(lines, "      "+styleMuted.Render(firstLine(d)))
		}
		steps := asList(jm["steps"])
		for _, s := range steps {
			sm, ok := s.(map[string]any)
			if !ok {
				continue
			}
			task, _ := sm["task"].(map[string]any)
			deps := stepDeps(sm)
			arrow := ""
			if len(deps) > 0 {
				arrow = styleMuted.Render(" ← " + strings.Join(deps, ", "))
			}
			target := taskTarget(task)
			lines = append(lines, "    "+styleGreen.Render("•")+" "+str(sm["name"])+
				styleMuted.Render("  "+target)+arrow)
		}
	}
	return lines
}

// stepDeps extracts the names this step depends on from its dependsOn list,
// which may be bare strings or {step, condition} objects.
func stepDeps(step map[string]any) []string {
	var deps []string
	for _, d := range asList(step["dependsOn"]) {
		switch t := d.(type) {
		case string:
			deps = append(deps, t)
		case map[string]any:
			if s := str(t["step"]); s != "" {
				deps = append(deps, s)
			}
		}
	}
	return deps
}

// taskTarget summarises a step's task as "model.method" or "workflow:<name>".
func taskTarget(task map[string]any) string {
	if task == nil {
		return ""
	}
	switch str(task["type"]) {
	case "model_method":
		mn := firstNonEmpty(
			str(task["modelName"]),
			str(task["modelIdOrName"]),
			str(task["modelType"]),
		)
		if mn == "" {
			return str(task["methodName"])
		}
		return mn + "." + str(task["methodName"])
	case "workflow":
		return "workflow:" + firstNonEmpty(str(task["workflowIdOrName"]), str(task["workflowName"]))
	}
	return str(task["type"])
}

// firstNonEmpty returns the first non-empty string.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// selectModel loads detail for the currently selected model and its data list.
// The returned command must not mutate m (it runs on a goroutine); it only reads
// fields captured here.
func (m *Model) selectModel() tea.Cmd {
	models := m.visibleModels()
	if len(models) == 0 {
		return nil
	}
	sel := models[clamp(m.modelSel, 0, len(models)-1)]
	name, typ := sel.label, sel.sub
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		lines := []string{
			styleKey.Render("name ") + name,
			styleKey.Render("type ") + typ,
		}

		detail, err := client.GetModel(ctx, name)
		if err != nil {
			return detailLoadedMsg{title: name, lines: append(lines, styleError.Render("model.get: "+err.Error())), err: err}
		}

		if v, ok := detail["version"]; ok {
			lines = append(lines, styleKey.Render("ver  ")+str(v))
		}
		if tv, ok := detail["currentTypeVersion"]; ok {
			lines = append(lines, styleKey.Render("typev")+" "+str(tv))
		}

		lines = append(lines, "", stylePaneTitle.Render("Methods"))
		methods := asList(detail["methods"])
		if len(methods) == 0 {
			lines = append(lines, styleMuted.Render("  (none)"))
		}
		for _, meth := range methods {
			mm, ok := meth.(map[string]any)
			if !ok {
				continue
			}
			lines = append(lines, "  "+styleGreen.Render("•")+" "+str(mm["name"]))
			if d := str(mm["description"]); d != "" {
				lines = append(lines, "    "+styleMuted.Render(firstLine(d)))
			}
		}

		// Type describe gives data output specs (best-effort).
		if t, err := client.DescribeType(ctx, typ); err == nil {
			lines = append(lines, "", stylePaneTitle.Render("Data outputs"))
			specs := asList(t["dataOutputSpecs"])
			if len(specs) == 0 {
				lines = append(lines, styleMuted.Render("  (none)"))
			}
			for _, spec := range specs {
				sm, ok := spec.(map[string]any)
				if !ok {
					continue
				}
				lines = append(lines, "  "+styleOrange.Render("◦")+" "+str(sm["specName"])+
					styleMuted.Render("  "+str(sm["kind"])))
			}
		}

		var items []dataItem
		if dl, err := client.ListData(ctx, name); err == nil {
			for _, grp := range asList(dl["groups"]) {
				gm, ok := grp.(map[string]any)
				if !ok {
					continue
				}
				for _, it := range asList(gm["items"]) {
					im, ok := it.(map[string]any)
					if !ok {
						continue
					}
					items = append(items, dataItem{
						node: node{
							label: str(im["name"]),
							sub:   str(im["type"]) + " v" + str(im["version"]) + "  " + humanSize(im["size"]),
							kind:  "data",
						},
						ref: runOutput{
							name:        str(im["name"]),
							modelName:   name,
							version:     int(numVal(im["version"])),
							contentType: str(im["contentType"]),
							kind:        str(im["type"]),
						},
					})
				}
			}
			sort.Slice(items, func(i, j int) bool { return items[i].node.label < items[j].node.label })
		}
		nodes := make([]node, len(items))
		refs := make([]runOutput, len(items))
		for i, it := range items {
			nodes[i], refs[i] = it.node, it.ref
		}
		return detailLoadedMsg{title: name, root: RootModel, name: name, lines: lines, items: nodes, refs: refs}
	}
}

// loadDataContent fetches one data item's content and formats it. For workflow
// data it uses the workflow-scoped data.get (modelIdOrName is empty).
func (m *Model) loadDataContent(rootKind RootKind, rootName, dataName string, width int) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		d, err := client.GetDataScoped(ctx, rootKind == RootWorkflow, rootName, dataName, 0)
		if err != nil {
			return detailLoadedMsg{title: dataName, lines: []string{styleError.Render("data.get: " + err.Error())}, err: err}
		}
		scope := "model "
		if rootKind == RootWorkflow {
			scope = "wf    "
		}
		lines := []string{styleKey.Render("data  ") + dataName, styleKey.Render(scope) + rootName}
		if ct := str(d["contentType"]); ct != "" {
			lines = append(lines, styleKey.Render("ctype ")+ct)
		}
		lines = append(lines, "")
		lines = append(lines, prettyContent(d, width)...)
		return detailLoadedMsg{title: dataName, lines: lines}
	}
}

// visibleSpotter returns the current ranked matches for the query.
func (m *Model) visibleSpotter() []spotterItem {
	q := strings.ToLower(strings.TrimSpace(m.spotterQuery))
	if q == "" {
		// Show a small, deterministic default: first few models.
		n := len(m.spotterIndex)
		if n > 40 {
			n = 40
		}
		return m.spotterIndex[:n]
	}
	type scored struct {
		it    spotterItem
		score int
	}
	var hits []scored
	for _, it := range m.spotterIndex {
		label := strings.ToLower(it.label)
		sub := strings.ToLower(it.sub)
		var score int
		switch {
		case label == q:
			score = 1000
		case strings.HasPrefix(label, q):
			score = 800
		case strings.Contains(label, q):
			score = 600
		case strings.Contains(sub, q):
			score = 300
		default:
			continue
		}
		// Prefer models/workflows over data on equal match quality.
		switch it.kind {
		case "model":
			score += 30
		case "workflow":
			score += 20
		}
		hits = append(hits, scored{it, score})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].it.label < hits[j].it.label
	})
	out := make([]spotterItem, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.it)
	}
	return out
}

// visibleModels applies the live filter to the model list.
func (m *Model) visibleModels() []node {
	return filterNodes(m.models, m.filter)
}

// visibleWorkflows applies the live filter to the workflow list.
func (m *Model) visibleWorkflows() []node {
	return filterNodes(m.workflows, m.filter)
}

// filterNodes returns nodes whose label or sub matches the (lowercased) filter.
func filterNodes(nodes []node, filter string) []node {
	if filter == "" {
		return nodes
	}
	f := strings.ToLower(filter)
	out := make([]node, 0, len(nodes))
	for _, n := range nodes {
		if strings.Contains(strings.ToLower(n.label), f) ||
			strings.Contains(strings.ToLower(n.sub), f) {
			out = append(out, n)
		}
	}
	return out
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
