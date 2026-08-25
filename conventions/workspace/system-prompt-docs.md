## System-prompt docs

This file, each project's `CLAUDE.md`, everything they import, and the conductor role doc (`.conduct/CONVENTIONS.md`) load into the system prompt of every session — each sentence is a recurring per-session cost. When writing or editing any of them:

- **Test every claim: would the agent act differently — or read a tool result differently — because it knows this?** If behavior is identical without the sentence, it's color, not instruction: cut it (e.g., implementation detail the agent never acts on).
- **Rationale only where it steers a judgment call.** Absolute rules get no *why*.
- **Each instruction once, in its single best home** — cross-reference rather than restate.
- **Push what nothing volunteers.** Cut a fact some channel delivers unasked at point of use — a tool schema, an error or refusal, a pre-resolved field, a doc the reader is already opening. Keep one whose only channel is the reader thinking to ask, including a fact guarding an action they'd otherwise never attempt.
