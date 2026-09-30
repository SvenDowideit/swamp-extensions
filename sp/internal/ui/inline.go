package ui

import (
	"strings"

	"charm.land/lipgloss/v2"
)

// parseInline parses a small inline-markdown subset into styled runs:
// **bold**, *italic* / _italic_, `code`, and [text](url). Unmatched markers are
// left literal.
func parseInline(s string) []inlineRun {
	var runs []inlineRun
	var buf strings.Builder
	st := lipgloss.NewStyle()

	flush := func() {
		if buf.Len() > 0 {
			runs = append(runs, inlineRun{st: st, text: buf.String()})
			buf.Reset()
		}
	}
	for i := 0; i < len(s); {
		switch {
		case strings.HasPrefix(s[i:], "**"):
			if j := strings.Index(s[i+2:], "**"); j >= 0 {
				flush()
				runs = append(runs, inlineRun{st: st.Bold(true), text: s[i+2 : i+2+j]})
				i += 2 + j + 2
				continue
			}
			buf.WriteString("**")
			i += 2
		case s[i] == '`':
			if j := strings.IndexByte(s[i+1:], '`'); j >= 0 {
				flush()
				runs = append(runs, inlineRun{st: lipgloss.NewStyle().Foreground(colAccent2), text: s[i+1 : i+1+j]})
				i += 1 + j + 1
				continue
			}
			buf.WriteByte('`')
			i++
		case strings.HasPrefix(s[i:], "["):
			if text, url, n, ok := parseLink(s[i:]); ok {
				flush()
				runs = append(runs, inlineRun{st: lipgloss.NewStyle().Foreground(colAccent).Underline(true), text: text})
				// Append the target only when it adds information beyond the
				// link text (a terminal has no clickable hyperlinks).
				if url != "" && !strings.HasPrefix(url, "#") && text != url {
					runs = append(runs, inlineRun{st: lipgloss.NewStyle().Foreground(colMuted), text: " (" + url + ")"})
				}
				i += n
				continue
			}
			buf.WriteByte('[')
			i++
		case s[i] == '*' || s[i] == '_':
			marker := s[i]
			if j := strings.IndexByte(s[i+1:], marker); j > 0 {
				flush()
				runs = append(runs, inlineRun{st: st.Italic(true), text: s[i+1 : i+1+j]})
				i += 1 + j + 1
				continue
			}
			buf.WriteByte(marker)
			i++
		default:
			// consume a run of ordinary characters up to the next marker
			next := i + 1
			for next < len(s) && !isMarker(s[next]) {
				next++
			}
			buf.WriteString(s[i:next])
			i = next
		}
	}
	flush()
	if len(runs) == 0 {
		runs = append(runs, inlineRun{text: ""})
	}
	return runs
}

func isMarker(b byte) bool {
	switch b {
	case '*', '_', '`', '[':
		return true
	}
	return false
}

// parseLink parses "[text](url)" at the start of s, returning the text, url and
// number of bytes consumed.
func parseLink(s string) (text, url string, n int, ok bool) {
	if len(s) == 0 || s[0] != '[' {
		return "", "", 0, false
	}
	close := strings.IndexByte(s, ']')
	if close < 0 || close+1 >= len(s) || s[close+1] != '(' {
		return "", "", 0, false
	}
	end := strings.IndexByte(s[close+2:], ')')
	if end < 0 {
		return "", "", 0, false
	}
	return s[1:close], s[close+2 : close+2+end], close + 2 + end + 1, true
}
