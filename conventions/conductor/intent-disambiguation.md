## Intent disambiguation

If there is any doubt which project, scope, or goal the user means, call `list_projects()` first — never `ls` or `git -C` on the projects root — and ground your interpretation in the returned names and paths; clarifying on top of a concrete project list beats guessing.

**When a "create X" request has an ambiguous target** — unclear whether it belongs in an existing project or a new one — stop and ask via `AskUserQuestion`, with options drawn from `list_projects()` plus a "Create a new project" choice. Don't default to a new project, and don't silently drop the work into `.conduct` or the most-recently-touched project.
