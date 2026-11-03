---
version: alpha
name: Dovo Terminal
description: A calm, dense terminal client for supervising coding agents.
colors:
  primary: "{colors.accent}"
  text: "#e6e1d8"
  muted: "#8b8578"
  dim: "#6a655b"
  accent: "#e8a04c"
  user: "#7fb4d3"
  ok: "#93b77a"
  warn: "#e8c05c"
  error: "#d46a5c"
  border: "#4a463f"
  code: "#c9b98a"
components:
  header:
    textColor: "{colors.muted}"
  project-row:
    textColor: "{colors.text}"
  task-row:
    textColor: "{colors.text}"
  task-row-hint:
    textColor: "{colors.muted}"
  status-running:
    textColor: "{colors.ok}"
  status-waiting:
    textColor: "{colors.warn}"
  status-error:
    textColor: "{colors.error}"
  status-idle:
    textColor: "{colors.muted}"
  overlay-border:
    textColor: "{colors.border}"
  key-hint:
    textColor: "{colors.dim}"
omitted:
  - section: typography
    reason: "A terminal draws in the user's own font; only bold, italic, underline and strikethrough are used."
  - section: spacing
    reason: "Layout is measured in character cells, which this format's px/em/rem units cannot express."
  - section: rounded
    reason: "Cells have no corner radius."
---

# Dovo Terminal

## Overview

The interface is for a person who leaves agents running and comes back to
decide things. It is quiet when nothing needs them and plain about what does:
a waiting task is the only thing that is allowed to look urgent. It favours
density and keyboard flow over decoration, and it works on any terminal
background, so every colour is a role that a theme can replace, never a fixed
value.

## Colors

Ten roles carry all colour. The tokens above are the default theme, Dovo;
other themes redefine the same ten roles and nothing else. Source of truth:
`packages/tui/src/theme/presets.ts`.

- **Text (#e6e1d8):** body text and the names of things.
- **Muted (#8b8578):** supporting facts: counts, providers, ages.
- **Dim (#6a655b):** the quietest layer: key hints and empty states.
- **Accent (#e8a04c):** the product's voice: the brand mark, headings,
  fold markers, the agent's label. `primary` points at it.
- **User (#7fb4d3):** the person's own messages and links.
- **Ok (#93b77a), Warn (#e8c05c), Error (#d46a5c):** status only. Running is
  ok, waiting-for-you is warn, failed is error. Nothing else uses them.
- **Border (#4a463f):** rules and frames.
- **Code (#c9b98a):** inline code and code blocks.

Presets cover both background schemes. Themes must keep `text` readable on the
terminal background; a theme file may not add roles.

## Layout

One screen at a time under a one-line header. The task list is a tree: a
project header, then its tasks indented two cells. Lists scroll; overlays sit
centred at 60–70% width and take every key until dismissed.

## Elevation & Depth

There is none. Overlays are separated by a frame in the `border` colour, not
by shadow or fill.

## Components

- **Header:** brand, connection dot, counts, and the most useful keys.
- **Project row:** fold marker (`▾` open, `▸` folded), name in bold, then a
  count with running and waiting tasks called out in their status colours.
- **Task row:** status glyph, title, then provider and age in `muted`.
- **Status:** a glyph plus words, never colour alone: `●` running, `●`
  waiting, `○` idle, `✗` error, `?` unknown. Shape and wording carry the
  meaning for people who cannot tell the colours apart, and for `NO_COLOR`.
- **Overlay:** a theme picker, a confirmation, or an approval choice.

## Do's and Don'ts

- Do reach for a role by name; do not write a hex value in a screen.
- Do pair every status colour with a glyph and words.
- Do keep one way to do each thing: each action has a single key.
- Don't add a colour role to express something a glyph or word already says.
- Don't use `ok`, `warn` or `error` for decoration.
- Don't rely on bold or colour alone to separate a project from its tasks:
  the indent and fold marker do that.
