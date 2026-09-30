package ui

import "charm.land/lipgloss/v2"

// Palette — a muted, terminal-friendly scheme.
var (
	colBG      = lipgloss.Color("#0b0f14")
	colPanel   = lipgloss.Color("#111823")
	colBorder  = lipgloss.Color("#263445")
	colAccent  = lipgloss.Color("#5fd7ff")
	colAccent2 = lipgloss.Color("#c9a0ff")
	colGreen   = lipgloss.Color("#8bd450")
	colOrange  = lipgloss.Color("#ffb86c")
	colMuted   = lipgloss.Color("#5c6b7a")
	colText    = lipgloss.Color("#d6dee8")
	colRed     = lipgloss.Color("#ff6b6b")
)

var (
	styleTitle = lipgloss.NewStyle().
			Bold(true).
			Foreground(colBG).
			Background(colAccent).
			Padding(0, 1)

	styleSubtitle = lipgloss.NewStyle().
			Foreground(colMuted)

	styleStatus = lipgloss.NewStyle().
			Foreground(colMuted)

	styleError = lipgloss.NewStyle().
			Foreground(colRed).
			Bold(true)

	stylePaneTitle = lipgloss.NewStyle().
			Bold(true).
			Foreground(colAccent)

	stylePaneTitleBlur = lipgloss.NewStyle().
				Bold(true).
				Foreground(colMuted)

	stylePane = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colBorder).
			Padding(0, 1)

	stylePaneFocus = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colAccent).
			Padding(0, 1)

	styleSelected = lipgloss.NewStyle().
			Bold(true).
			Foreground(colBG).
			Background(colAccent)

	styleSelectedBlur = lipgloss.NewStyle().
				Bold(true).
				Foreground(colText).
				Background(colBorder)

	styleItem = lipgloss.NewStyle().
			Foreground(colText)

	styleItemSub = lipgloss.NewStyle().
			Foreground(colMuted)

	styleKey = lipgloss.NewStyle().
			Foreground(colAccent).
			Bold(true)

	styleKind = lipgloss.NewStyle().
			Foreground(colAccent2)

	styleScrollTrack = lipgloss.NewStyle().Foreground(colBorder)
	styleScrollThumb = lipgloss.NewStyle().Foreground(colAccent)

	styleGreen  = lipgloss.NewStyle().Foreground(colGreen)
	styleOrange = lipgloss.NewStyle().Foreground(colOrange)
	styleMuted  = lipgloss.NewStyle().Foreground(colMuted)
)
