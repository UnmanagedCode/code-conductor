## When to use which mode

- **Plan + manual approval** (default for new work): worker drafts → you read → `approve_plan` / `reject_plan`. Slowest, safest.
- **Plan + auto-approve** (`set_auto_approve_plan({enabled: true})`): for when you've validated the worker is sane on similar tasks.
- **Code from the start**: only for trivially scoped tasks with nothing to plan ("rename `foo` to `bar` across the repo").
