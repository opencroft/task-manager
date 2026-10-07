# Task Manager

OpenCroft extension: a task manager (timeline, board, tasks, workflows) with
actions for agents.

## UI components come from the design kit

This extension is a shadcn project (`components.json`, `@/*` paths in
`tsconfig.json`). The components under `src/components/` are installed from
the design kit's registry with its install script, run from the repository
root. They are changed in the kit and re-installed, never edited in place.

After an install, check `git status`: an install writes every file in the
dependency graph, not only the component you named.

Base primitives (a bare name in a component's registry dependencies, such as
`button`) come from the shadcn registry itself and import `cn` from shadcn's
`cn` package. `@/lib/utils` re-exports that same `cn`, so kit components and
primitives share one implementation and an install leaves both as they are.

One primitive carries a local fix, so an install with `--overwrite` must not
take its registry copy: `command.tsx` styles the highlighted item with
`data-[selected=true]:`. The registry's `data-selected:` matches the attribute
whenever it is present, and cmdk writes `data-selected="false"` on every item
it has not highlighted, so every row of a list would look highlighted.

The extension compiler builds the stylesheet itself from the class names used
under `src/`, against the host theme; `src/app.css` exists only for the CLI.

## Across projects

Each `tasks` App is one project. `my_work` and `task_list` take
`scope: "all"` to answer for every task-manager App the caller can see, in
one request: the App called reads the others' databases in-process, through
the same per-instance handle their own actions use (`server/projects/`).
Every row then carries its project (`app`, the `<space>.<app>` address, in
compact rows). At most `PROJECTS_READ_MAX` projects are read, and the answer
says how many there were and which could not be read. `task_list` across
projects refuses the filters that name something of one project (`status`,
`version`, `parent`, `sort`, `offset`).

Which Apps the caller can see is decided in one function,
`visibleProjects`: today the host lets anyone signed in, and any agent, open
every App, so it is every instance. A host rule per space or per App would
go there.

The UI asks only on request: My work's *All projects* on opening and after
changes (debounced), the palette and the Tasks page only while a search is
typed. A task of another project opens in its own App through the host's
`useOpenApp`.

## Bounded answers for agents

An agent's answer is compact by default (`shared/compact.ts`), and a compact
answer is also bounded where a list grows without end:
- `task_get` holds the latest 5 comments with `commentsTotal`
  (`commentsLimit` raises it to 50). Its related tasks and subtasks are rows
  of key, summary and status, and empty fields are left out.
- `task_comments` pages through all of a task's comments, newest first, with
  a `(created_at, id)` cursor that stays right while comments come and go.
- `my_work` returns the first 10 assigned tasks with `assignedTotal`
  (`assignedLimit` raises it to 200); across projects the cap is on the
  merged list.

The pages ask for `detail: "full"` (`src/lib/api.ts`), which ignores the
limits: the task page still shows every comment, and My work every task.

## Checks before merging

- `npm test`: the server's `node --test` suites and the UI helpers' tests.
- `npm run typecheck`: strict, over `src`, `server`, `shared`, `test` and
  `scripts`. `@opencroft/client`, `@opencroft/server` and the host's React
  types come from the OpenCroft host, so run it from a copy of this
  repository placed inside an OpenCroft source checkout, where those resolve;
  in a standalone clone they cannot, and the run checks nothing.
- A compile with the host's extension build at the commit the target instance
  runs.

## Smoke check (`npm run smoke:stage`)

A change that touches the App shell or wraps the page pane (`tasks-app.tsx`,
the chat dock, the sidebar, the page pane) runs this against an instance it
is deployed to:

| Check | What passes |
| --- | --- |
| `load <app>/<page>` | Each page of each configured App (My work, Tasks, Board, Timeline, Workflows, a task) loads with no page errors, and the App makes **0 calls of its own in 5 s idle**. The host's calls in that window are listed as an `info` line, never failed. |
| `back-scroll <app> <n> via task` | Tasks list scrolled to `n`, open a visible task, Back gives `n`; Forward, Back again gives `n`. |
| `back-scroll <app> <n> via board` | Tasks list scrolled to `n`, the sidebar's Board, Back gives `n`. |
| `leave <app> via switcher / graph / back` | Leaving the App through the title bar's App switcher, the graph link, and Back/Forward via another App stays out (no bounce back in). |
| `phone <app> <width>` | At that width, each page tapped in the sidebar sheet opens and closes the sheet, and no page is wider than the screen. |

It drives a remote Playwright MCP browser, one call and one isolated browser
context per check, and creates no data. The browser's default context must
already be signed in to the instance. It needs:

- `SMOKE_CONFIG`: the path of a JSON file holding a `SmokeConfig`
  (`scripts/smoke-stage/checks.ts`), for example:

  ```json
  {
    "origin": "https://tasks.example.com",
    "space": "space-1",
    "extension": "my-org.task-manager",
    "apps": ["app-a", "app-b"],
    "pages": ["my-work", "tasks", "board", "timeline", "workflows", "task"],
    "backScroll": [
      { "app": "app-a", "top": 300, "via": "task" },
      { "app": "app-b", "top": 3000, "via": "board" }
    ],
    "leave": { "app": "app-a", "switchTo": "app-b", "otherApp": "other-app" },
    "phone": { "app": "app-a", "width": 390, "height": 800, "pages": ["board", "timeline", "workflows", "my-work", "tasks"] }
  }
  ```

- `QA_BROWSER_URL`: the browser's MCP endpoint.
- `QA_BROWSER_AUTH`: its credential, a whole `Authorization` value,
  `user:password`, or its base64. Without one of these the script stops with
  a "not set" message.
- `SMOKE_ORIGIN` (optional) overrides the config's `origin`.

```sh
npm run smoke:stage                   # every check; exit 0 only if all pass
npm run smoke:stage -- --only back    # checks whose id contains "back"
npm run smoke:stage -- --list         # the check ids
npm run smoke:stage -- --print "leave app-a via graph"   # one check's browser function
```

- **Output:** progress per check on stderr, then a markdown table on stdout:
  every assertion as pass, **FAIL** or info, then each failure with the step it
  stopped at and a screenshot under `smoke-results/<time>/` (`--no-shots` turns
  them off).
- **Where things live:** `scripts/smoke-stage.ts` (the runner),
  `scripts/smoke-stage/checks.ts` (what runs against which App, and the table),
  `scripts/smoke-stage/mcp.ts` (the MCP client), and `scripts/smoke-stage/browser/`
  (the checks as Playwright functions, sent as source text).
- **Without the credential:** `--print` gives a check's function, which runs
  unchanged through any client of the browser's `browser_run_code_unsafe` tool.
- **Budget:** a browser server may close a call's browser contexts after a time
  limit, so every check stays short. A check that outgrows it has to be split,
  as leaving the App is into three.
- **Changing the App's shell or selectors:** the checks find things by the
  App's `data-slot`s (`tasks-sidebar`, `scroll-area-viewport`), the host's
  title bar (`title-bar`, `popover-trigger`, `popover-content`) and sheet
  (`sidebar` with `data-mobile`), and the `Open sidebar` button. Renaming one
  of those means updating `browser/` in the same change.
