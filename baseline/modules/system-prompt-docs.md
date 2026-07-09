## System-prompt docs: instruction, not color

This file, each project's `CLAUDE.md`, and everything they import (e.g. `CONDUCT.md`) load into the system prompt of every session — each sentence is a recurring per-session cost. When writing or editing any of them:

- **Test every claim: would the agent act differently — or read a tool result differently — because it knows this?** If behavior is identical without the sentence, it's color, not instruction: cut it.
- **Rationale only where it steers a judgment call.** Absolute rules get no *why*.
- **Each instruction once, in its single best home** — cross-reference rather than restate.
- **Don't restate what arrives at point of use** — tool schemas, error messages, READMEs, on-demand playbooks and wiki pages already deliver that content when needed, and restated copies drift stale.
