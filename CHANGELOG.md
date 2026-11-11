# Change Log

## Unreleased

- **Custom actions are kept per folder**: removing a project or deleting a universe no longer deletes its custom actions. Adding the folder again brings them back, and a folder that is in two universes shares one set. Existing action files are moved to the new naming on the first start.
- **Project actions file**: a project can bring its own actions in `.vscode/work-universe.json`. When it exists it replaces your stored actions for that folder (only in a trusted window). **Move Custom Actions to Project File** creates it from your current actions.

## 0.0.3

- **Fix**: switching away from a workspace shown as a solution and back showed its plain folder structure instead of the solution.

## 0.0.2

- **Solution view**: a workspace folder that contains a Visual Studio solution (`.sln` / `.slnx`) can be shown like Visual Studio's Solution Explorer: solution folders, projects, Dependencies / References and nested files (`Form1.Designer.cs` under `Form1.cs`, `appsettings.Development.json` under `appsettings.json`, …). You're asked when adding the folder, or use **Set Solution File...** on the tab. Projects that can't be loaded show why on hover.
- **Switching keeps shared folders loaded**: folders that are loaded before and after a switch are no longer removed and re-added, so language servers such as C# Dev Kit don't reload their projects.

## 0.0.1

Initial release.

- **Universes**: group several project folders in one window and switch between them from one panel in the activity bar.
- **Panel**: a tab per project, with an Explorer-style file tree below it (icon theme, git and problem colors, keyboard navigation, multi-select, drag to move, new/rename/delete).
- **Per-project editor tabs**: each project gets its own tabs back when you return to it, including split editors, pinned tabs and the active tab.
- **Two modes per universe**: separate environments (search, source control and the Explorer follow the active project) or all together (every project stays loaded, switching is faster).
- **Custom actions**: per-project icon buttons that run shell commands or VS Code commands, with optional headless terminals, status bar items and a running color. Can be created from `package.json` scripts.
- **Color and icon per project**, a status bar indicator, a quick switcher and keyboard shortcuts.
- **Search whole universe** in one step.
