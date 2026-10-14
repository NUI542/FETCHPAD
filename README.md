# Fetchpad

A map of a codebase built only from parsing the source: no part of it is guessed by an AI. It's a personal tool, built from the "Spatial Code Map for VS Code" product document.

## Status

Milestone 2 of 5: the map runs inside VS Code, opened from its own sidebar in any project.

- **Overview.** Pages (and other callers) → endpoints → tables. Endpoints are grouped by resource. *Show reads* adds the tables each endpoint reads.
- **Focus.** Focus on any page, endpoint, function or table to see its whole chain: Pages | Components | API client | Endpoints | Handlers | Logic | Data access | Tables. Functions that lead to no endpoint or table are folded into "+N helpers". *Show helpers* expands them.
- **Code previews.** The plus icon on a block opens its code in place. The block's lines are highlighted and the rest is folded. Previews are coloured with your VS Code theme, show unsaved edits, can be dragged, and stay pinned to their block. Middleware chips open the middleware's code.
- **Navigation.**
  - Hover a block to light up its connections. Click to pin the highlight.
  - Double-click a block or preview to open the source.
  - Click a wire to open the line that proves it.
  - Escape closes the top preview.
- **Live updates.** The map rebuilds when files change on disk, including files an agent writes. Re-analysis runs in a worker thread and takes about 0.5s on a 10k-line project.

The engine understands:

- **Express**: apps, routers, `app.use(prefix, router)` mounts, and the middleware chain each route runs, in order.
- **Client calls**: `fetch` and axios, including through wrapper functions such as `request()` and `send()`. Calls are matched to Express routes the way Express itself matches them.
- **React Router**: `<Route>` trees, so you can see which page shows which component.
- **SQL in code**: which tables each function reads and writes (pg, mysql2, sqlite).
- **Schema files**: tables, columns and foreign keys from `.sql` files.
- **Calls and renders**: which functions call each other and which components render each other, following `require`, `import` and `module.exports`.

Anything it cannot prove is reported as a gap, never guessed.

Not yet handled: React context (a page calling `useAuth().login` is not linked to the provider's `login`), and path aliases from `tsconfig`/`vite.config`.

## Use it

Click the **Fetchpad** icon in the Activity Bar (the left edge of VS Code) in any project. The sidebar shows:

- **Open Code Map**, which opens the map in a tab beside your code
- **Endpoints** grouped by resource, **Pages**, **Tables** and **Gaps**

Click an item to open the map focused on it. The file icon next to it opens its source. The buttons in the sidebar's title open the map and analyze again. In a workspace with several folders, a third button picks which folder to map.

Analysis starts the first time you open the sidebar or the map, and then follows file changes.

### Install or update

```sh
npm run package                                    # builds fetchpad-<version>.vsix
code --install-extension fetchpad-0.1.0.vsix --force
```

Then reload any open VS Code windows (**Developer: Reload Window**).

### Develop

Open this folder in VS Code and start **Run Fetchpad on Project app** from the Run and Debug view (or press F5). That opens `Project app` in a window running the code from `dist/`.

```sh
npm install
npm run build            # dev bundles into dist/ (npm run watch to rebuild on change)
npm test                 # engine and view tests
npm run typecheck
npm run analyze -- "C:/path/to/project" [--route "POST /api/tasks"]   # text report
npm run harness -- "C:/path/to/project"  # run the map in a browser: .fetchpad/harness/index.html
```

## Layout

| Path | What it holds |
|---|---|
| `src/model/types.ts` | The graph: nodes, edges, gaps |
| `src/engine/` | Analysis: `analyze.ts` runs the adapters, `adapters/` has one file per framework |
| `src/extension/` | VS Code side: panel, analysis worker, theme-aware highlighting |
| `src/webview/` | The map: `views.ts` (overview and focus views), `layout.ts` (ELK), React Flow components |
| `src/shared/protocol.ts` | Messages between the extension, the webview and the worker |
| `src/cli/analyze.ts` | Text report |
| `scripts/` | Build, and the browser harness |
| `test/fixtures/mini-app` | Small app that reproduces real-world patterns |
