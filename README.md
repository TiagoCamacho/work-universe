# Work Universe

Group several project folders (for example `backend` and `frontend`) into a **universe** and work on **one at a time** in a single VS Code window. The explorer, search, source control and open tabs all follow the active workspace. It feels like several VS Code windows living in one window.

## Features

- **One activity bar panel**, with no sections:
  - **Tabs on top**, one per folder. Click to switch, `+` to add, drag to reorder, right-click to rename, recolor or remove.
  - **File tree below**, like the Explorer: your file icon theme, git and problem colors, the active file revealed, keyboard navigation, multi-select, drag to move, and New/Rename (F2)/Delete from the right-click menu.
  - **`…` menu** in the panel header to open, create, rename or delete universes.
- **In-place switching** with no window reload. Each workspace remembers its own tabs (groups, pinned tabs, active tab and cursor) and gets them back when you return to it.
- **Isolated search**: `Ctrl+Shift+F` only searches the active workspace.
- **Search whole universe** (`Ctrl+Alt+Shift+F`) temporarily loads every workspace so one search covers all of them.
- **Status bar** shows `Universe › Workspace`. Click it to switch.
- **Quick switcher** (`Ctrl+Alt+W`), plus `Ctrl+Alt+]` / `Ctrl+Alt+[` for the next and previous workspace.
- **Color and icon per workspace**, so the title bar and status bar tell you where you are.

## Separate environments or all together

Each universe has a mode. You choose it when you create the universe and can change it any time from the panel's `…` menu → **Set Universe Mode**.

| | Separate environments (default) | All together |
|---|---|---|
| Folders loaded in the window | Only the active project | Every project, all the time |
| Switching | Changes the window's folders (VS Code, git and language servers react each time) | Only swaps the panel and the editor tabs, so it is faster |
| Search (`Ctrl+Shift+F`) | Only the active project | Pre-filled to the active project (`./name`); clear the field to search everything |
| Quick open (`Ctrl+P`), Source Control, native Explorer | Only the active project | All projects |
| Work Universe panel, tabs per project, custom actions, colors | Same | Same |

Changing the mode applies immediately, without a reload. The `◈` header folder stays in both modes, so switching modes never restarts extensions.

## Custom actions

Each workspace can have its own row of icon buttons between the tabs and the files. Right-click a tab and choose **Set Custom Actions…**. The first time, it offers to create buttons from the project's `package.json` scripts, using the right package manager (npm, pnpm, yarn or bun). It then opens the actions file in an editor tab, with autocomplete for every field and icon name. Save it and the buttons update.

```jsonc
{
  "actions": [
    { "label": "Dev",   "icon": "play",   "command": "npm run dev" },
    { "label": "Tests", "icon": "beaker", "command": "npm test", "cwd": "packages/api", "env": { "CI": "1" } },
    { "label": "Restart TS", "icon": "refresh", "vscodeCommand": "typescript.restartTsServer" }
  ]
}
```

- `command` runs in the action's **own terminal** (`<workspace>: <label>`) in the workspace folder. Pressing the button while it's still running lets you **Restart** it or **Show** the terminal.
- `vscodeCommand` runs a VS Code command instead (with optional `args`).
- Optional: `cwd` (relative to the workspace), `env`, and `color` (a hex color for the icon).
- `headless: true` runs the command without showing its terminal. Press the button again to show, restart or stop it.
- `show_status_bar: true` shows the action's icon and label in the status bar while it runs. Click it to open its terminal.
- `active_color` (top level, `"#hex"` or `"none"`) colors the icons of actions that are currently running.
- New action files start with a comment that documents every property. Colors get VS Code's color picker.
- Action files live in the extension's storage. Nothing is written into your project.

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

## Performance

Switching is built so that what you see changes first:

- Clicking a tab updates the panel in the same instant. A workspace you've already visited shows its whole tree from memory and refreshes it in the background.
- The new workspace's active editor opens first (one per side with split editors), and the old tabs close after it.
- VS Code's own folder change (search, source control, language servers) runs alongside, not before.
- The remaining tabs are added in the background.
- Clicking several tabs quickly skips the ones in between.
- The file tree only draws the rows in view, so very large folders stay fast.

Timings of every switch are written to the **Work Universe** output channel (`View → Output`), e.g. `switch → backend: state=0.4ms firstEditor=70ms folders=180ms tabs=250ms total=330ms`.

## Known limitations

- **Terminals and debug sessions are shared** across workspaces. VS Code has no API to hide terminals per workspace.
- Extensions that treat `workspaceFolders[0]` as "the project" will see the anchor folder.
- Renaming the universe open in the current window updates the explorer header the next time the universe is opened.
- Explorer expand/collapse state per workspace is up to VS Code.

## Development

```
npm install
npm test           # unit + integration tests (runs inside a generated universe window)
```

Press **F5** with **Run Extension (Universe)** selected. It generates a sample universe in `.dev/` (backend + frontend) and starts the Extension Development Host already inside it. Don't use *File → Open Folder* in the Development Host: switching the window to another folder ends the debug session and closes the window. Add folders with the `+` tab instead.
