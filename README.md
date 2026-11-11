# Work Universe

Group several project folders (for example `backend` and `frontend`) into a **universe** and work on **one at a time** in a single VS Code window. The explorer, search, source control and open tabs all follow the active workspace. It feels like several VS Code windows living in one window.

## Features

- **Activity bar panel**: create universes, add folders and switch with a click.
- **In-place switching** with no window reload. Each workspace remembers its own tabs (groups, pinned tabs, active tab and cursor) and gets them back when you return to it.
- **Isolated search**: `Ctrl+Shift+F` only searches the active workspace.
- **Search whole universe** (`Ctrl+Alt+Shift+F`) temporarily loads every workspace so one search covers all of them.
- **Status bar** shows `Universe › Workspace`. Click it to switch.
- **Quick switcher** (`Ctrl+Alt+W`), plus `Ctrl+Alt+]` / `Ctrl+Alt+[` for the next and previous workspace.
- **Color and icon per workspace**, so the title bar and status bar tell you where you are.

## How it works

Each universe is a generated `.code-workspace` file kept in the extension's storage:

```
◈ My Product        ← fixed "anchor" folder (always empty, never searched)
backend             ← the active workspace, swapped in place
```

VS Code restarts **every** extension when the *first* workspace folder changes. The anchor stays at position 0, so switching only touches position 1 and nothing restarts. Your Claude chat, language servers and so on keep running.

Opening a universe from a normal window reloads the window **once**. Every switch after that is instant.

## Settings

| Setting | Default | |
|---|---|---|
| `workUniverse.dirtyFiles` | `prompt` | What happens to unsaved files when you switch: `prompt`, `save` or `keepOpen`. |
| `workUniverse.applyColors` | `true` | Tint the title bar, activity bar and status bar with the workspace color. |

## Known limitations

- **Terminals and debug sessions are shared** across workspaces. VS Code has no API to hide terminals per workspace.
- Extensions that treat `workspaceFolders[0]` as "the project" will see the anchor folder.
- Renaming the universe open in the current window updates the explorer header the next time the universe is opened.
- Explorer expand/collapse state per workspace is up to VS Code.

## Development

```
npm install
npm run watch      # then press F5 to open an Extension Development Host
npm test           # unit + integration tests (runs inside a generated universe window)
```
