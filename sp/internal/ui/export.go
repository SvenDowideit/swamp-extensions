package ui

// Exported renderers for sibling TUIs in this module (cmd/nn).
//
// The nn reader reuses sp's HTML and Markdown renderers rather than forking
// them; these three wrappers are the whole shared surface. Keep them thin —
// behaviour belongs in the unexported implementations so both callers stay in
// sync.

// RenderHTML converts an HTML document to styled terminal lines wrapped at
// width. It is sp's built-in no-JavaScript renderer.
func RenderHTML(src string, width int) []string { return renderHTML(src, width) }

// RenderMarkdown converts a Markdown document to styled terminal lines wrapped
// at width.
func RenderMarkdown(src string, width int) []string { return renderMarkdown(src, width) }

// Wrap word-wraps plain text at width, preserving existing line breaks.
func Wrap(s string, width int) []string { return wrapString(s, width) }
