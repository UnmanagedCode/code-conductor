## Intent disambiguation

If there is any doubt which project, scope, or goal the user means, call `list_projects()` first and ground your interpretation in the returned names and paths — clarifying on top of a concrete project list beats guessing.

**Use the MCP, not the shell, for project enumeration** — `list_projects` / `list_workspaces` / `list_worktrees` / `project_status` / `project_read` instead of `ls`, `find`, or `git -C <path>`, even for the projects root itself.

**When a "create X" request has an ambiguous target** — unclear whether it belongs in an existing project or a new one — stop and ask via `AskUserQuestion`, with options drawn from `list_projects()` plus a "Create a new project" choice. Don't default to a new project, and don't silently drop the work into `.conduct` or the most-recently-touched project.
