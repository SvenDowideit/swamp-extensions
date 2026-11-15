package nn

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// Field is one editable input, derived from a method or workflow argument
// schema. Nothing here is hand-written per workflow: swamp already declares
// type, default, enum, minimum, maximum and required, which is exactly what a
// magit-style transient needs.
type Field struct {
	Name     string
	Type     string
	Desc     string
	Required bool
	Enum     []string
	Min      float64
	Max      float64
	HasMin   bool
	HasMax   bool
	Default  any

	Text string
	Bool bool
}

// IsBool reports whether the field is a toggle.
func (f *Field) IsBool() bool { return f.Type == "boolean" }

// inputFields derives fields from a JSON Schema object ({properties, required}).
// Properties are ordered alphabetically so the form is stable between runs;
// required fields come first, then optional ones, so the required inputs are
// the ones you see without scrolling.
func inputFields(schema any) []*Field {
	root, ok := schema.(map[string]any)
	if !ok {
		return nil
	}
	props, _ := root["properties"].(map[string]any)
	if len(props) == 0 {
		return nil
	}
	required := map[string]bool{}
	if list, ok := root["required"].([]any); ok {
		for _, r := range list {
			if s, ok := r.(string); ok {
				required[s] = true
			}
		}
	}

	names := make([]string, 0, len(props))
	for name := range props {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		ri, rj := required[names[i]], required[names[j]]
		if ri != rj {
			return ri
		}
		return names[i] < names[j]
	})

	fields := make([]*Field, 0, len(names))
	for _, name := range names {
		pm, _ := props[name].(map[string]any)
		f := &Field{
			Name:     name,
			Type:     scalar(pm["type"]),
			Desc:     scalar(pm["description"]),
			Required: required[name],
			Default:  pm["default"],
		}
		if f.Type == "" {
			if _, ok := pm["anyOf"].([]any); ok {
				f.Type = "any"
			} else if _, ok := pm["oneOf"].([]any); ok {
				f.Type = "any"
			} else {
				f.Type = "string"
			}
		}
		for _, e := range asScalars(pm["enum"]) {
			f.Enum = append(f.Enum, e)
		}
		if v, ok := pm["minimum"].(float64); ok {
			f.Min, f.HasMin = v, true
		}
		if v, ok := pm["maximum"].(float64); ok {
			f.Max, f.HasMax = v, true
		}
		f.Reset()
		fields = append(fields, f)
	}
	return fields
}

// asScalars renders a JSON array of scalars as strings.
func asScalars(v any) []string {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		out = append(out, scalar(e))
	}
	return out
}

// Reset restores the field to its declared default.
func (f *Field) Reset() {
	if f.Default == nil {
		f.Text, f.Bool = "", false
		return
	}
	switch v := f.Default.(type) {
	case bool:
		f.Bool = v
		f.Text = scalar(v)
	case string:
		f.Text = v
	case float64:
		f.Text = scalar(v)
	case []any, map[string]any:
		b, _ := json.Marshal(v)
		f.Text = string(b)
	default:
		f.Text = scalar(v)
	}
}

// Value converts the field's edit state back to the JSON value the method
// expects. An untouched optional field yields (nil, false) and is omitted, so a
// workflow's own defaults apply.
func (f *Field) Value() (any, bool, error) {
	if f.IsBool() {
		return f.Bool, true, nil
	}
	text := strings.TrimSpace(f.Text)
	if text == "" {
		return nil, false, nil
	}
	switch f.Type {
	case "integer":
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return nil, false, fmt.Errorf("%s: not an integer", f.Name)
		}
		if (f.HasMin && float64(n) < f.Min) || (f.HasMax && float64(n) > f.Max) {
			return nil, false, fmt.Errorf("%s: out of range %s..%s", f.Name,
				scalar(f.Min), scalar(f.Max))
		}
		return n, true, nil
	case "number":
		v, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return nil, false, fmt.Errorf("%s: not a number", f.Name)
		}
		return v, true, nil
	case "boolean":
		return strings.EqualFold(text, "true"), true, nil
	case "array":
		// Accept JSON or a comma-separated list.
		if strings.HasPrefix(text, "[") {
			var out []any
			if err := json.Unmarshal([]byte(text), &out); err != nil {
				return nil, false, fmt.Errorf("%s: invalid JSON array", f.Name)
			}
			return out, true, nil
		}
		parts := strings.Split(text, ",")
		out := make([]any, 0, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			if n, err := strconv.ParseInt(p, 10, 64); err == nil {
				out = append(out, n)
			} else {
				out = append(out, p)
			}
		}
		return out, true, nil
	case "object":
		var out map[string]any
		if err := json.Unmarshal([]byte(text), &out); err != nil {
			return nil, false, fmt.Errorf("%s: invalid JSON object", f.Name)
		}
		return out, true, nil
	default:
		if len(f.Enum) > 0 {
			for _, e := range f.Enum {
				if e == text {
					return text, true, nil
				}
			}
			return nil, false, fmt.Errorf("%s: must be one of %s", f.Name,
				strings.Join(f.Enum, ", "))
		}
		return text, true, nil
	}
}

// current is the focused field.
func (f *formState) current() *Field {
	if f.sel < 0 || f.sel >= len(f.fields) {
		return nil
	}
	return f.fields[f.sel]
}

// formState is the run form item UI: a list of fields plus an inline editor.
type formState struct {
	workflow string
	fields   []*Field
	sel      int
	editing  bool
	err      string
	notice   string
}

// newForm builds a form, prefilling from last when it is non-empty.
func newForm(workflow string, schema any, last map[string]any) *formState {
	f := &formState{workflow: workflow, fields: inputFields(schema)}
	if f.fields == nil {
		f.fields = []*Field{}
	}
	if len(last) > 0 {
		for _, fld := range f.fields {
			v, ok := last[fld.Name]
			if !ok {
				continue
			}
			switch t := v.(type) {
			case bool:
				fld.Bool = t
			default:
				fld.Text = scalar(t)
				if lst, ok := v.([]any); ok {
					b, _ := json.Marshal(lst)
					fld.Text = string(b)
				}
			}
		}
		f.notice = "restored the last run's inputs"
	}
	return f
}

// submitValues validates every field and returns the inputs map.
func (f *formState) submitValues() (map[string]any, error) {
	out := map[string]any{}
	for _, fld := range f.fields {
		v, set, err := fld.Value()
		if err != nil {
			return nil, err
		}
		if !set {
			if fld.Required {
				return nil, fmt.Errorf("%s is required", fld.Name)
			}
			continue
		}
		out[fld.Name] = v
	}
	return out, nil
}

// restore applies a previously used input set.
func (f *formState) restore(in map[string]any) {
	if len(in) == 0 {
		f.notice = "no previous run of this workflow"
		return
	}
	for _, fld := range f.fields {
		v, ok := in[fld.Name]
		if !ok {
			continue
		}
		if b, ok := v.(bool); ok {
			fld.Bool = b
			continue
		}
		if lst, ok := v.([]any); ok {
			bs, _ := json.Marshal(lst)
			fld.Text = string(bs)
			continue
		}
		fld.Text = scalar(v)
	}
	f.notice = "restored the last run's inputs"
	f.err = ""
}

// move shifts the field focus.
func (f *formState) move(delta int) {
	if len(f.fields) == 0 {
		return
	}
	f.sel = (f.sel + delta + len(f.fields)) % len(f.fields)
}

// render draws the form.
func (f *formState) render(width, height int) []string {
	out := make([]string, 0, height)
	head := styleDim.Render(fmt.Sprintf("workflow %s", f.workflow))
	if req := f.requiredCount(); req > 0 {
		head += styleDim.Render(fmt.Sprintf(" · %d required", req))
	}
	out = append(out, head, "")

	for i, fld := range f.fields {
		cursor := "  "
		if i == f.sel {
			cursor = "▸ "
		}
		marker := " "
		if fld.Required {
			marker = "*"
		}
		name := padRight(fld.Name, 18)
		var value string
		switch {
		case i == f.sel && f.editing:
			value = styleAccent.Render(padRight(fld.Text, 30)) + styleDim.Render("  ← editing (enter to keep, esc to revert)")
		case fld.IsBool():
			box := "( ) off"
			if fld.Bool {
				box = "(x) on"
			}
			value = box
		case fld.Text == "":
			value = styleDim.Render("(unset)")
		default:
			value = fld.Text
		}
		row := fmt.Sprintf("%s%s %s %s", cursor, marker, name, value)
		if i == f.sel {
			out = append(out, styleSelected.Render(fit(row, width)))
			if fld.Desc != "" {
				out = append(out, "     "+styleDim.Render(fit(fld.Desc, width-5)))
			}
		} else {
			out = append(out, fit(row, width))
		}
		if len(out) >= height-2 {
			break
		}
	}
	if f.err != "" {
		out = append(out, styleErr.Render(fit("! "+f.err, width)))
	} else if f.notice != "" {
		out = append(out, styleDim.Render(fit("· "+f.notice, width)))
	}
	return out
}

// requiredCount is how many fields are required.
func (f *formState) requiredCount() int {
	n := 0
	for _, fld := range f.fields {
		if fld.Required {
			n++
		}
	}
	return n
}

// footerKeys is the key bar for the form.
func (f *formState) footerKeys() string {
	if len(f.fields) == 0 {
		return "ctrl+s run  = cancel"
	}
	return "tab/↑↓ field  space toggle  enter edit  ctrl+r last run  ctrl+s run  = cancel"
}

// editHint explains the empty-field case in the status line.
func (f *formState) editHint() string {
	if len(f.fields) == 0 {
		return styleDim.Render("no inputs declared; ctrl+s runs it now")
	}
	return ansi.Truncate(f.fields[f.sel].Desc, 60, "…")
}
