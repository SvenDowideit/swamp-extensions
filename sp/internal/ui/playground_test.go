package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

func TestPlaygroundOpensAndEdits(t *testing.T) {
	m := sampleModel()
	press(m, 'p', "")
	if !m.pgOpen {
		t.Fatalf("p should open the Playground")
	}
	// 'e' enters edit mode on the focused (predicate) field.
	press(m, 0, "e")
	if !m.pgEditing {
		t.Fatalf("e should enter edit mode")
	}
	m.pgPred = ""
	for _, r := range "size >= 0" {
		press(m, 0, string(r))
	}
	if m.pgPred != "size >= 0" {
		t.Fatalf("predicate edit failed: %q", m.pgPred)
	}
	// backspace removes a char
	press(m, tea.KeyBackspace, "")
	if m.pgPred != "size >= " {
		t.Fatalf("backspace failed: %q", m.pgPred)
	}
}

func TestPlaygroundTabSwitchesField(t *testing.T) {
	m := sampleModel()
	m.pgOpen = true
	if m.pgField != 0 {
		t.Fatalf("starts on predicate")
	}
	press(m, tea.KeyTab, "")
	if m.pgField != 1 {
		t.Fatalf("tab should move to select, got %d", m.pgField)
	}
	press(m, tea.KeyTab, "")
	if m.pgField != 0 {
		t.Fatalf("tab should wrap to predicate, got %d", m.pgField)
	}
}

func TestPlaygroundEmptyPredicateErrors(t *testing.T) {
	m := sampleModel()
	m.pgOpen = true
	m.pgPred = "   "
	_, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}))
	if m.pgErr == nil {
		t.Fatalf("empty predicate should error")
	}
	if cmd != nil {
		t.Fatalf("empty predicate should not issue a query")
	}
}

func TestPlaygroundResultMsgStoresRows(t *testing.T) {
	m := sampleModel()
	m.pgOpen = true
	res := &swamp.QueryResult{Predicate: "size >= 0", Total: 2, Records: []map[string]any{
		{"modelName": "bom", "name": "forecast", "version": float64(9), "dataType": "resource", "size": float64(3276)},
		{"modelName": "bom", "name": "hourly", "version": float64(11), "dataType": "resource"},
	}}
	m.Update(pgResultMsg{result: res, rows: pgRowsFromResult(res)})
	if m.pgRows[0].name != "forecast" || m.pgRows[0].version != 9 {
		t.Fatalf("record rows not parsed: %+v", m.pgRows)
	}
	out := strip(m.render())
	if !strings.Contains(out, "forecast") || !strings.Contains(out, "bom") {
		t.Fatalf("record results not rendered:\n%s", out)
	}
}

func TestPlaygroundScalarAndProjectionShapes(t *testing.T) {
	m := sampleModel()
	m.pgOpen = true
	m.width, m.height = 120, 40

	// scalar shape
	m.pgResult = &swamp.QueryResult{
		Total:     2,
		Projected: &swamp.Projection{Shape: "scalar", Values: []any{"install", "summary"}},
	}
	out := strip(m.render())
	if !strings.Contains(out, "install") || !strings.Contains(out, "summary") {
		t.Fatalf("scalar projection not rendered:\n%s", out)
	}

	// map (named columns) shape
	m.pgResult = &swamp.QueryResult{
		Total: 1,
		Projected: &swamp.Projection{
			Shape:   "map",
			Columns: []string{"model", "name"},
			Rows:    []any{map[string]any{"model": "pulse", "name": "index.html"}},
		},
	}
	out = strip(m.render())
	if !strings.Contains(out, "model") || !strings.Contains(out, "pulse") || !strings.Contains(out, "index.html") {
		t.Fatalf("map projection not rendered:\n%s", out)
	}

	// list (positional) shape
	m.pgResult = &swamp.QueryResult{
		Total: 1,
		Projected: &swamp.Projection{
			Shape: "list",
			Rows:  []any{[]any{"bom", "forecast", "9"}},
		},
	}
	out = strip(m.render())
	if !strings.Contains(out, "forecast") || !strings.Contains(out, "bom") {
		t.Fatalf("list projection not rendered:\n%s", out)
	}
}

func TestPlaygroundErrorRendersCaret(t *testing.T) {
	m := sampleModel()
	m.pgOpen = true
	m.Update(pgResultMsg{err: errTest{}})
	out := strip(m.render())
	if !strings.Contains(out, "query failed") || !strings.Contains(out, "boom") {
		t.Fatalf("query error not rendered:\n%s", out)
	}
}

func TestPlaygroundHistoryNavigation(t *testing.T) {
	m := sampleModel()
	m.pgOpen = true
	m.pgHistory = []pgQuery{
		{pred: "size >= 0", selectExpr: ""},
		{pred: `modelName == "bom"`, selectExpr: "name"},
	}
	m.pgHistIdx = 1
	m.pgPred = `modelName == "bom"`
	// [ goes back
	press(m, 0, "[")
	if m.pgPred != "size >= 0" {
		t.Fatalf("history back failed: %q", m.pgPred)
	}
	// ] goes forward
	press(m, 0, "]")
	if m.pgPred != `modelName == "bom"` || m.pgSelect != "name" {
		t.Fatalf("history forward failed: pred=%q sel=%q", m.pgPred, m.pgSelect)
	}
}

func TestPlaygroundRecordSelectionMovesAndOpens(t *testing.T) {
	m := sampleModel()
	m.pgOpen = true
	res := &swamp.QueryResult{Total: 3, Records: []map[string]any{
		{"modelName": "m", "name": "a", "dataType": "resource"},
		{"modelName": "m", "name": "b", "dataType": "resource"},
		{"modelName": "m", "name": "c", "dataType": "resource"},
	}}
	m.Update(pgResultMsg{result: res, rows: pgRowsFromResult(res)})
	press(m, tea.KeyDown, "")
	if m.pgRowSel != 1 {
		t.Fatalf("down should select row 1, got %d", m.pgRowSel)
	}
	press(m, 0, "v")
	if !m.viewOpen {
		t.Fatalf("v on a selected record should open the viewer")
	}
	if m.viewArtifact.name != "b" {
		t.Fatalf("viewer opened %q, want b", m.viewArtifact.name)
	}
}
