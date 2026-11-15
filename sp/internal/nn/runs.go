package nn

import (
	"context"
	"fmt"
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
