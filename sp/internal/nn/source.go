package nn

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// API is the slice of the swamp serve client the loaders need. swamp.Client
// satisfies it; tests supply a fake.
type API interface {
	GetData(ctx context.Context, model, name string, version int) (map[string]any, error)
	SearchWorkflows(ctx context.Context, query string) (map[string]any, error)
	SearchModels(ctx context.Context, query string) (map[string]any, error)
}

// Loader resolves group specs into items through the serve client. It holds no
// state of its own beyond the client, so a group can be reloaded at any time.
type Loader struct {
	API API
}

// Load fills g from its spec. On failure it records g.Err and leaves Items
// untouched: a group that failed must render its reason, never look empty.
func (l *Loader) Load(ctx context.Context, g *Group) error {
	var err error
	switch g.Spec.Kind {
	case "data":
		err = l.loadData(ctx, g)
	case "objects":
		err = l.loadObjects(ctx, g)
	default:
		err = fmt.Errorf("unknown group kind %q", g.Spec.Kind)
	}
	if err != nil {
		g.Err = err.Error()
		return err
	}
	g.Err = ""
	g.Loaded = true
	g.Total = len(g.Items)
	sortItems(g.Items, parseSort(g.Spec.Sort))
	return nil
}

// loadData reads one swamp data resource and projects it through the spec.
func (l *Loader) loadData(ctx context.Context, g *Group) error {
	if g.Spec.Model == "" || g.Spec.Resource == "" {
		return fmt.Errorf("data group needs model and resource")
	}
	d, err := l.API.GetData(ctx, g.Spec.Model, g.Spec.Resource, 0)
	if err != nil {
		return fmt.Errorf("%s/%s: %w", g.Spec.Model, g.Spec.Resource, err)
	}
	content := decodeContent(d["content"])
	root := lookup(content, g.Spec.Path)
	rows := asRows(root)
	if len(rows) == 0 && root != nil {
		return fmt.Errorf("%s/%s: path %q is not a list", g.Spec.Model, g.Spec.Resource, g.Spec.Path)
	}
	g.Items = make([]*Item, 0, len(rows))
	for i, row := range rows {
		g.Items = append(g.Items, projectItem(&g.Spec, g.ID(), row, i))
	}
	return nil
}

// loadObjects lists swamp workflows or models as items.
func (l *Loader) loadObjects(ctx context.Context, g *Group) error {
	var (
		res map[string]any
		err error
	)
	switch g.Spec.Collection {
	case "workflows":
		res, err = l.API.SearchWorkflows(ctx, "")
	case "models":
		res, err = l.API.SearchModels(ctx, "")
	default:
		return fmt.Errorf("unknown collection %q", g.Spec.Collection)
	}
	if err != nil {
		return err
	}
	rows := asRows(res["results"])
	g.Items = make([]*Item, 0, len(rows))
	for i, row := range rows {
		g.Items = append(g.Items, projectItem(&g.Spec, g.ID(), row, i))
	}
	return nil
}

// projectItem applies a spec's field paths to one source record.
func projectItem(spec *GroupSpec, groupID string, row map[string]any, index int) *Item {
	id := scalar(lookup(row, spec.IDField))
	if id == "" {
		id = fmt.Sprintf("%s#%d", groupID, index)
	}
	it := &Item{
		ID:     id,
		Group:  groupID,
		Format: spec.Format,
		Raw:    row,
	}
	for _, path := range spec.Menu {
		it.Cols = append(it.Cols, scalar(lookup(row, path)))
	}
	it.Body = scalar(lookup(row, spec.Body))
	for _, path := range spec.Meta {
		if v := scalar(lookup(row, path)); v != "" {
			it.Meta = append(it.Meta, v)
		}
	}
	it.Link = scalar(lookup(row, spec.Link))
	if spec.NewSince != "" {
		it.NewSince = timestampFor(lookup(row, spec.NewSince))
		it.SortKey = sortTime(it.NewSince)
	}
	if spec.Badge != "" {
		if truthy(lookup(row, spec.Badge)) {
			it.Badge = spec.BadgeTag
			if it.Badge == "" {
				it.Badge = "SEC"
			}
		}
	}
	return it
}

// decodeContent accepts a data payload's content either already decoded or as a
// JSON string (both shapes occur in swamp data).
func decodeContent(v any) any {
	s, ok := v.(string)
	if !ok {
		return v
	}
	var parsed any
	if err := json.Unmarshal([]byte(s), &parsed); err == nil {
		return parsed
	}
	return s
}

// asRows coerces a decoded value to a list of records.
func asRows(v any) []map[string]any {
	list, ok := v.([]any)
	if !ok {
		if m, ok := v.(map[string]any); ok {
			return []map[string]any{m}
		}
		return nil
	}
	out := make([]map[string]any, 0, len(list))
	for _, e := range list {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// truthy reads a JSON value as a boolean flag.
func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != "" && !strings.EqualFold(t, "false") && t != "0"
	case []any:
		return len(t) > 0
	case nil:
		return false
	default:
		return true
	}
}
