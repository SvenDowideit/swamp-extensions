package nn

import (
	"context"
	"fmt"
	"sync"

	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// loadRuns lists runnable workflows. Each item carries a Child group that the
// shell pushes on space/enter: that workflow's history, with a synthetic
// "+ run" item at the top.
func (l *Loader) loadRuns(ctx context.Context, g *Group) error {
	res, err := l.API.SearchWorkflows(ctx, "")
	if err != nil {
		return err
	}
	rows := asRows(res["results"])
	g.Items = make([]*Item, 0, len(rows))
	g.Children = g.Children[:0]
	for i, row := range rows {
		it := projectItem(&g.Spec, g.ID(), row, i)
		name := it.ID
		if name == "" {
			continue
		}
		child := &Group{Spec: GroupSpec{
			ID:       g.ID() + "/" + name,
			Title:    name,
			Parent:   g.ID(),
			Kind:     "runhistory",
			Workflow: name,
			IDField:  "runId",
			Format:   "run",
			// Columns are laid out by the loader, not by field paths: run rows
			// come from workflow.run.search, whose shape is not a data record.
			Menu:     []string{"startedAt", "status", "progress", "duration"},
			Sort:     "startedAt desc",
			PageSize: g.Spec.PageSize,
		}}
		it.Child = child.ID()
		g.Children = append(g.Children, child)
		g.Items = append(g.Items, it)
	}
	return nil
}

// loadRunHistory builds the menu the design calls "history first": one
// synthetic "+ run" item, then the workflow's recent runs, newest first.
func (l *Loader) loadRunHistory(ctx context.Context, g *Group) error {
	name := g.Spec.Workflow
	if name == "" {
		return fmt.Errorf("runhistory group needs a workflow")
	}
	runs, err := l.API.SearchWorkflowRuns(ctx, name, 50)
	if err != nil {
		return err
	}

	runItem := &Item{
		ID:     "+",
		Group:  g.ID(),
		Format: "form",
		Pinned: true,
		Raw:    map[string]any{"workflow": name},
	}
	schema, err := l.API.GetWorkflow(ctx, name)
	if err != nil {
		runItem.Cols = []string{"run this workflow…", "(inputs unavailable)"}
		runItem.Raw["inputError"] = err.Error()
	} else {
		inputs := lookup(schema, "inputs")
		fields := inputFields(inputs)
		runItem.Cols = []string{
			"run this workflow…",
			fmt.Sprintf("(%d inputs)", len(fields)),
		}
		runItem.Raw["inputs"] = inputs
	}

	g.Items = make([]*Item, 0, len(runs)+1)
	g.Items = append(g.Items, runItem)
	for _, r := range runs {
		it := &Item{
			ID:       r.RunID,
			Group:    g.ID(),
			Format:   "run",
			Status:   r.Status,
			NewSince: r.StartedAt,
			SortKey:  sortTime(r.StartedAt),
			Cols: []string{
				r.StartedAt,
				r.Status,
				progressLabel(r.StepsCompleted, r.StepsTotal),
				durationLabel(r.DurationMS),
			},
			Raw: map[string]any{
				"runId":         r.RunID,
				"workflowName":  r.WorkflowName,
				"status":        r.Status,
				"startedAt":     r.StartedAt,
				"failedStep":    r.FailedStep,
				"failureReason": r.FailureReason,
				"durationMs":    float64(r.DurationMS),
			},
		}
		switch r.Status {
		case "failed", "cancelled":
			it.Badge = "!"
			it.Body = r.FailureReason
		case "running", "pending":
			it.Badge = "▶"
		}
		g.Items = append(g.Items, it)
	}
	return nil
}

func progressLabel(done, total int) string {
	if total == 0 {
		return ""
	}
	return fmt.Sprintf("%d/%d", done, total)
}

func durationLabel(ms int64) string {
	if ms <= 0 {
		return ""
	}
	secs := ms / 1000
	switch {
	case secs < 60:
		return fmt.Sprintf("%ds", secs)
	case secs < 3600:
		return fmt.Sprintf("%dm%02ds", secs/60, secs%60)
	default:
		return fmt.Sprintf("%dh%02dm", secs/3600, (secs%3600)/60)
	}
}

// loadMethods flattens the behaviour catalogue into runnable rows: one line per
// (model instance, method). Flat, because the alternative is a third level of
// menu nesting, and depth 2 is the cap.
func (l *Loader) loadMethods(ctx context.Context, g *Group) error {
	res, err := l.API.SearchModels(ctx, "")
	if err != nil {
		return err
	}
	rows := asRows(res["results"])
	g.Items = make([]*Item, 0, len(rows)*2)
	g.Children = g.Children[:0]
	// model.search returns only id/name/type; the method list (with argument
	// schemas) lives on the model itself, so this is one model.get per instance.
	// Fetched with a small worker pool: ~100 instances is otherwise a visible
	// wait on a group you just asked for.
	full := fetchModels(ctx, l, rows)
	failed := 0
	for _, row := range full {
		if row == nil {
			failed++
			continue
		}
		modelName := scalar(row["name"])
		methods, _ := row["methods"].([]any)
		for _, m := range methods {
			mm, ok := m.(map[string]any)
			if !ok {
				continue
			}
			methodName := scalar(mm["name"])
			if methodName == "" {
				continue
			}
			id := modelName + "." + methodName
			it := &Item{
				ID:     id,
				Group:  g.ID(),
				Format: "runnable",
				Cols:   []string{modelName, methodName, scalar(mm["description"])},
				Raw: map[string]any{
					"model":  modelName,
					"method": methodName,
					"type":   scalar(row["type"]),
				},
				Child: g.ID() + "/" + id,
			}
			g.Children = append(g.Children, &Group{Spec: GroupSpec{
				ID:       it.Child,
				Title:    id,
				Parent:   g.ID(),
				Kind:     "methodhistory",
				Model:    modelName,
				Method:   methodName,
				IDField:  "id",
				Format:   "run",
				Menu:     []string{"startedAt", "status", "duration"},
				Sort:     "startedAt desc",
				PageSize: g.Spec.PageSize,
			}})
			g.Items = append(g.Items, it)
		}
	}
	if len(g.Items) == 0 && failed > 0 {
		return fmt.Errorf("%d model(s) could not be read for their methods", failed)
	}
	return nil
}

// fetchModels loads every model record concurrently, preserving order. Entries
// that failed are nil.
func fetchModels(ctx context.Context, l *Loader, rows []map[string]any) []map[string]any {
	out := make([]map[string]any, len(rows))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i, row := range rows {
		name := scalar(row["name"])
		if name == "" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, name string) {
			defer wg.Done()
			defer func() { <-sem }()
			rec, err := l.modelRecord(ctx, name)
			if err != nil {
				return
			}
			out[i] = rec
		}(i, name)
	}
	wg.Wait()
	return out
}

// loadMethodHistory is the method twin of loadRunHistory: "+ run" first, then
// that model.method's recent runs.
func (l *Loader) loadMethodHistory(ctx context.Context, g *Group) error {
	modelName, methodName := g.Spec.Model, g.Spec.Method
	if modelName == "" || methodName == "" {
		return fmt.Errorf("methodhistory group needs model and method")
	}

	runItem := &Item{
		ID:     "+",
		Group:  g.ID(),
		Format: "form",
		Pinned: true,
		Raw: map[string]any{
			"model":  modelName,
			"method": methodName,
		},
	}
	// The argument schema travels with the model record already; re-read it so
	// the form works even when the catalogue is stale.
	if m, err := l.findModel(ctx, modelName); err == nil {
		if schema := methodArguments(m, methodName); schema != nil {
			runItem.Raw["inputs"] = schema
			runItem.Cols = []string{"run " + methodName, fmt.Sprintf("(%d inputs)", len(inputFields(schema)))}
		}
	}
	if _, ok := runItem.Raw["inputs"]; !ok {
		runItem.Cols = []string{"run " + methodName, "(inputs unavailable)"}
		runItem.Raw["inputError"] = "no argument schema for " + modelName + "." + methodName
	}

	// model.output.search is scoped by model and bounded by limit. The
	// alternative, model.method.history.search, ignores its query parameter
	// server-side: its reply is every method run ever (~97 MB here, past the
	// WebSocket frame limit) and the CLI filters it locally. Not usable from a
	// TUI. Model-scoped outputs also say whether a workflow triggered the run.
	runs, err := l.API.SearchModelOutputs(ctx, modelName, 200)
	if err != nil {
		return err
	}
	kept := make([]swamp.ModelRunEntry, 0, 50)
	for _, r := range runs {
		if r.MethodName != methodName {
			continue
		}
		kept = append(kept, r)
		if len(kept) == 50 {
			break
		}
	}

	g.Items = make([]*Item, 0, len(kept)+1)
	g.Items = append(g.Items, runItem)
	for _, r := range kept {
		it := &Item{
			ID:       r.OutputID,
			Group:    g.ID(),
			Format:   "run",
			Status:   r.Status,
			NewSince: r.StartedAt,
			SortKey:  sortTime(r.StartedAt),
			Cols:     []string{r.StartedAt, r.Status, durationLabel(r.DurationMS)},
			Raw: map[string]any{
				"runId":        r.OutputID,
				"modelName":    r.ModelName,
				"methodName":   r.MethodName,
				"status":       r.Status,
				"startedAt":    r.StartedAt,
				"durationMs":   float64(r.DurationMS),
				"triggeredBy":  r.TriggeredBy,
				"workflowName": r.WorkflowName,
			},
		}
		switch r.Status {
		case "failed", "cancelled":
			it.Badge = "!"
			it.Body = r.ErrorMessage
		case "running", "pending":
			it.Badge = "▶"
		}
		g.Items = append(g.Items, it)
	}
	return nil
}

// findModel loads a model instance record (with its method argument schemas).
// model.search does not carry methods, so this must go through model.get.
func (l *Loader) findModel(ctx context.Context, name string) (map[string]any, error) {
	return l.modelRecord(ctx, name)
}

// methodArguments returns a method's declared argument schema.
func methodArguments(model map[string]any, method string) any {
	methods, _ := model["methods"].([]any)
	for _, m := range methods {
		mm, ok := m.(map[string]any)
		if !ok {
			continue
		}
		if scalar(mm["name"]) == method {
			return mm["arguments"]
		}
	}
	return nil
}
