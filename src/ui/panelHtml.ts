import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { PANEL_SCRIPT } from './panelScript';

/** HTML + script of the Work Universe panel (tab strip + file tree). */
export function panelHtml(webview: vscode.Webview, codiconCss: vscode.Uri): string {
	// The nonce is what lets only our own script run in the webview, so it must be unguessable.
	const nonce = randomBytes(24).toString('base64url');
	const csp = [
		`default-src 'none'`,
		`font-src ${webview.cspSource}`,
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
	].join('; ');
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${webview.asWebviewUri(codiconCss)}">
<style id="icon-theme"></style>
<style>
	:root { --accent: var(--vscode-focusBorder); --row: 22px; --indent: 8px; }
	* { box-sizing: border-box; }
	html, body { height: 100%; }
	body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); user-select: none; display: flex; flex-direction: column; overflow: hidden; }

	/* ---- tab strip ---- */
	.strip { flex: none; display: flex; flex-wrap: wrap; gap: 2px; align-items: stretch; padding: 2px 6px 0; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent)); }
	.tab, .tool { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px 3px; border: none; border-bottom: 2px solid transparent; background: transparent; color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground)); font: inherit; cursor: pointer; white-space: nowrap; max-width: 100%; border-radius: 3px 3px 0 0; }
	.tab:hover, .tool:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-foreground); }
	.tab:focus-visible, .tool:focus-visible, .urow:focus-visible, .primary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.tab.active { color: var(--vscode-tab-activeForeground, var(--vscode-foreground)); border-bottom-color: var(--tab-color, var(--accent)); font-weight: 600; }
	.tab .name { overflow: hidden; text-overflow: ellipsis; }
	.tab .codicon { font-size: 14px; color: var(--tab-color, inherit); }
	.tab.dragging { opacity: .4; }
	.tab.drop-before { box-shadow: inset 2px 0 0 var(--accent); }
	.tool { padding: 4px 6px 3px; }
	.tool.on { color: var(--vscode-foreground); border-bottom-color: var(--accent); }
	.spacer { flex: 1; }

	/* ---- action buttons ---- */
	.actions { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 1px; padding: 2px 6px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent)); }
	.actions.hidden { display: none; }
	.act { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 22px; padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; }
	.act:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
	.act:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); }
	.act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.act .codicon { font-size: 16px; color: var(--act-color, inherit); }
	.act.edit { margin-left: auto; opacity: .55; }
	.act.edit:hover { opacity: 1; }

	/* ---- file tree ---- */
	.tree { flex: 1; overflow: auto; outline: none; padding-bottom: 8px; }
	.row { position: relative; display: flex; align-items: center; height: var(--row); line-height: var(--row); padding-right: 8px; cursor: pointer; white-space: nowrap; }
	.row:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-list-hoverForeground, inherit); }
	.row.selected { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
	.tree:focus .row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground, inherit); }
	.tree:focus .row.focused { outline: 1px solid var(--vscode-list-focusOutline, var(--accent)); outline-offset: -1px; }
	.row.drop-target { background: var(--vscode-list-dropBackground); }
	.row.faded .label { opacity: .6; }
	.guide { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--vscode-tree-inactiveIndentGuidesStroke, rgba(128,128,128,.25)); }
	.tree:hover .guide { background: var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,.5)); }
	.twistie { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; color: var(--vscode-icon-foreground, inherit); }
	.ic { flex: none; width: 16px; height: var(--row); margin-right: 6px; display: inline-flex; align-items: center; justify-content: center; background-size: 16px 16px; background-repeat: no-repeat; background-position: center; -webkit-font-smoothing: antialiased; }
	.ic::before { line-height: 1; }
	.ic.none { width: 0; margin-right: 2px; }
	.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
	.badge { flex: none; margin-left: 6px; font-size: 0.9em; opacity: .95; }
	/* Only the rows in view exist in the DOM: .vspace has the full height, .vrows is shifted into place. */
	.vspace { position: relative; }
	.vrows { position: absolute; top: 0; left: 0; right: 0; }
	.empty, .hint { padding: 6px 12px; color: var(--vscode-descriptionForeground); line-height: 1.5; }

	/* ---- no universe ---- */
	.universes { padding: 6px 8px; }
	.urow { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; border: none; background: transparent; color: var(--vscode-foreground); font: inherit; text-align: left; cursor: pointer; border-radius: 3px; }
	.urow:hover { background: var(--vscode-list-hoverBackground); }
	.urow .count { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
	.primary { margin-top: 8px; padding: 4px 10px; border: none; border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; cursor: pointer; }
	.primary:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<div id="strip"></div>
<div id="actions" class="actions hidden" role="toolbar" aria-label="Workspace actions"></div>
<div id="tree" class="tree" role="tree" tabindex="0" aria-label="Files"></div>
<script nonce="${nonce}">
${PANEL_SCRIPT}
</script>
</body>
</html>`;
}
