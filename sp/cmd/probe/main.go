// Command probe exercises the swamp serve client against a running server and
// dumps response shapes. It is a development aid for the TUI.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

func dump(label string, v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	if len(b) > 3000 {
		b = b[:3000]
	}
	fmt.Printf("\n=== %s ===\n%s\n", label, b)
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	base := "ws://127.0.0.1:9090"
	if len(os.Args) > 1 {
		base = os.Args[1]
	}

	client, err := swamp.Dial(ctx, base, "")
	if err != nil {
		fmt.Println("dial failed:", err)
		os.Exit(1)
	}
	defer client.Close()

	if err := client.Handshake(ctx); err != nil {
		fmt.Println("handshake failed:", err)
		os.Exit(1)
	}
	fmt.Printf("connected: version=%s sha=%s\n", client.Version, client.GitSHA)

	models, err := client.SearchModels(ctx, "")
	if err != nil {
		fmt.Println("model.search failed:", err)
	} else {
		dump("model.search", models)
	}

	workflows, err := client.SearchWorkflows(ctx, "")
	if err != nil {
		fmt.Println("workflow.search failed:", err)
	} else {
		dump("workflow.search", workflows)
	}

	runs, err := client.RunHistory(ctx, false)
	if err != nil {
		fmt.Println("run.history failed:", err)
	} else {
		fmt.Printf("\n=== run.history ===\n%d runs\n", len(runs))
		if len(runs) > 0 {
			dump("first run", runs[0])
		}
	}

	if wf, err := client.SearchWorkflows(ctx, ""); err == nil {
		if list, ok := wf["results"].([]any); ok && len(list) > 0 {
			if first, ok := list[0].(map[string]any); ok {
				name, _ := first["name"].(string)
				if detail, err := client.GetWorkflow(ctx, name); err == nil {
					dump("workflow.get "+name, detail)
				}
			}
		}
	}
	if ts, err := client.SearchTypes(ctx, ""); err == nil {
		if list, ok := ts["results"].([]any); ok && len(list) > 0 {
			if first, ok := list[0].(map[string]any); ok {
				raw, _ := first["raw"].(string)
				if d, err := client.DescribeType(ctx, raw); err == nil {
					dump("model.type.describe methods["+raw+"]", asMaps(d["methods"]))
				}
			}
		}
	}
	if raw, err := client.Request(ctx, swamp.ReqDataQuery, map[string]any{
		"predicate": `size >= 0`,
		"select":    `[modelName, name, string(version), dataType]`,
	}); err == nil {
		dump("data.query raw payload", json.RawMessage(raw))
	} else {
		fmt.Println("data.query failed:", err)
	}
	if raw, err := client.Request(ctx, swamp.ReqDataQuery, map[string]any{
		"predicate": `dataType == "resource"`,
		"select":    `[modelName, name]`,
	}); err == nil {
		dump("data.query predicate2", json.RawMessage(raw))
	} else {
		fmt.Println("data.query2 failed:", err)
	}
	if m, err := client.SearchModels(ctx, ""); err == nil {
		if list, ok := m["results"].([]any); ok && len(list) > 0 {
			if first, ok := list[0].(map[string]any); ok {
				name, _ := first["name"].(string)
				if name != "" {
					if detail, err := client.GetModel(ctx, name); err == nil {
						dump("model.get "+name+" (keys)", keys(detail))
						if types, ok := detail["type"].(string); ok && types != "" {
							if td, err := client.DescribeType(ctx, types); err == nil {
								dump("model.type.describe "+types+" (keys)", keys(td))
							}
						}
					}
					if dl, err := client.ListData(ctx, name); err == nil {
						dump("data.list "+name, dl)
					}
				}
			}
		}
	}
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func asMaps(v any) []map[string]any {
	list, _ := v.([]any)
	out := make([]map[string]any, 0, len(list))
	for _, it := range list {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
