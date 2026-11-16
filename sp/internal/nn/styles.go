package nn

import "charm.land/lipgloss/v2"

// Palette. Deliberately restrained: nn's menu was read at a glance, so colour
// carries state (unread, selected, failed) and nothing else.
var (
	colBG      = lipgloss.Color("#0b0f14")
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
	styleHeaderKey = lipgloss.NewStyle().Bold(true).
			Foreground(colBG).Background(colAccent).Padding(0, 1)
	styleTitle   = lipgloss.NewStyle().Bold(true).Foreground(colText)
	styleDim     = lipgloss.NewStyle().Foreground(colMuted)
	styleErr     = lipgloss.NewStyle().Bold(true).Foreground(colRed)
	styleGreenS  = lipgloss.NewStyle().Foreground(colGreen)
	styleOrangeS = lipgloss.NewStyle().Foreground(colOrange)
	styleAccent  = lipgloss.NewStyle().Foreground(colAccent)
	styleAccent2 = lipgloss.NewStyle().Foreground(colAccent2)

	styleUnread   = lipgloss.NewStyle().Bold(true).Foreground(colText)
	styleSeen     = lipgloss.NewStyle().Foreground(colText)
	styleRead     = lipgloss.NewStyle().Foreground(colMuted)
	styleSelected = lipgloss.NewStyle().Bold(true).Foreground(colBG).Background(colAccent)

	styleCursor = lipgloss.NewStyle().Bold(true).Foreground(colAccent)
	styleFooter = lipgloss.NewStyle().Foreground(colMuted)

	// styleKeyHint is the footer's key token: the thing you look for, so it gets
	// the brightest colour in the palette rather than the dimmest.
	styleKeyHint = lipgloss.NewStyle().Bold(true).Foreground(colGreen)
	styleRule    = lipgloss.NewStyle().Foreground(colBorder)
)
