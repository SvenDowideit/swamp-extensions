package ui

import (
	"context"
	"fmt"
	"sort"
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

	// lastRunID/lastFailedStep describe the most recent run of the current
	// workflow root, enabling resume-at-step.
	lastRunID      string
	lastFailedStep string

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

		if runs, err := client.SearchWorkflowRuns(ctx, name, 8); err == nil && len(runs) > 0 {
			lastRunID = runs[0].RunID
			lastFailedStep = runs[0].FailedStep
			lines = append(lines, "", stylePaneTitle.Render(fmt.Sprintf("Recent runs (%d)", len(runs))))
			for _, r := range runs {
				dot := styleGreen.Render("●")
				if r.Status != "succeeded" {
					dot = styleError.Render("●")
				}
				when := r.StartedAt
				if len(when) >= 16 {
					when = when[5:16] // MM-DDTHH:MM
				}
				line := fmt.Sprintf("  %s %-9s %s  %d/%d steps  %dms",
					dot, r.Status, when, r.StepsCompleted, r.StepsTotal, r.DurationMS)
				lines = append(lines, line)
				if r.FailedStep != "" {
					lines = append(lines, "      "+styleError.Render("failed at "+r.FailedStep))
				}
			}
		}

		items := workflowDataItems(ctx, client, name)
		return detailLoadedMsg{
			title: name, root: RootWorkflow, name: name,
			lines: lines, items: items, inputs: inputs,
			lastRunID: lastRunID, lastFailedStep: lastFailedStep,
		}
	}
}

// workflowDataItems loads data produced by a workflow, flattened into nodes.
func workflowDataItems(ctx context.Context, client *swamp.Client, name string) []node {
	items := []node{}
	dl, err := client.ListWorkflowData(ctx, name)
	if err != nil {
		return items
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
			items = append(items, node{label: str(im["name"]), sub: sub, kind: "data"})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].label < items[j].label })
	return items
}

// renderWorkflowDetail formats a workflow.get payload into display lines,
// showing jobs and their step dependency edges as a simple DAG.
func renderWorkflowDetail(wf map[string]any) []string {
	lines := []string{styleKey.Render("name ") + str(wf["name"])}
	if d := str(wf["description"]); d != "" {
		lines = append(lines, "", styleMuted.Render(d))
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

		items := []node{}
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
					items = append(items, node{
						label: str(im["name"]),
						sub:   str(im["type"]) + " v" + str(im["version"]) + "  " + humanSize(im["size"]),
						kind:  "data",
					})
				}
			}
			sort.Slice(items, func(i, j int) bool { return items[i].label < items[j].label })
		}
		return detailLoadedMsg{title: name, root: RootModel, name: name, lines: lines, items: items}
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
