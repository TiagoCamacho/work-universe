import * as path from 'path';
import * as vscode from 'vscode';
import { sameUri } from './universe/paths';
import { FileTarget } from './ui/fileModel';

/** What the file commands need from the panel. */
export interface FileTargets {
	/** Converts a command argument (webview context menu payload) into a target. */
	fromArg(arg: unknown): FileTarget | undefined;
	selected(): FileTarget[];
	roots(): readonly vscode.Uri[];
	changed(): void;
}

/** Explorer-style file operations for the Work Universe panel. */
export function registerFileCommands(context: vscode.ExtensionContext, targets: FileTargets): void {
	const register = (id: string, fn: (...args: any[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	const rootTarget = (): FileTarget | undefined => {
		const root = targets.roots()[0];
		return root ? { uri: root, root, isDirectory: true, isRoot: true } : undefined;
	};

	/** The clicked item, else the selection's first item, else the first root. */
	const resolve = (arg: unknown): FileTarget | undefined => targets.fromArg(arg) ?? targets.selected()[0];

	const folderOf = (t: FileTarget | undefined): FileTarget | undefined => {
		if (!t) {
			return rootTarget();
		}
		if (t.isDirectory) {
			return t;
		}
		const parent = vscode.Uri.joinPath(t.uri, '..');
		return { uri: parent, root: t.root, isDirectory: true, isRoot: sameUri(parent, t.root) };
	};

	const validateName = (value: string) => {
		const v = value.trim();
		if (!v) {
			return 'Enter a name';
		}
		if (process.platform === 'win32' && /[<>:"|?*]/.test(v)) {
			return 'The name contains characters that are not allowed';
		}
		// "../x" or "/x" would create or move things outside the folder that was clicked.
		if (v.split(/[\\/]+/).some(part => part === '..' || part === '.') || /^[\\/]/.test(v) || /^[A-Za-z]:/.test(v)) {
			return 'The name must stay inside this folder';
		}
		return undefined;
	};
	/** For rename: a single name, with no folder separators at all. */
	const validateSingleName = (value: string) =>
		/[\\/]/.test(value) ? 'A name cannot contain "/" or "\\"' : validateName(value);

	const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

	const create = async (arg: unknown, kind: 'file' | 'folder') => {
		const folder = folderOf(resolve(arg));
		if (!folder) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: kind === 'file' ? 'New File' : 'New Folder',
			prompt: `In ${vscode.workspace.asRelativePath(folder.uri, true)}. Use "/" to create nested folders.`,
			validateInput: validateName,
		});
		if (!name) {
			return;
		}
		const uri = vscode.Uri.joinPath(folder.uri, ...name.trim().split(/[\\/]+/).filter(Boolean));
		try {
			if (kind === 'folder') {
				await vscode.workspace.fs.createDirectory(uri);
			} else {
				const edit = new vscode.WorkspaceEdit();
				edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
				if (!(await vscode.workspace.applyEdit(edit))) {
					throw new Error(`"${name}" already exists.`);
				}
				await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
			}
			targets.changed();
		} catch (err) {
			vscode.window.showErrorMessage(`Could not create ${name}: ${errorText(err)}`);
		}
	};

	register('workUniverse.files.newFile', (arg?: unknown) => create(arg, 'file'));
	register('workUniverse.files.newFolder', (arg?: unknown) => create(arg, 'folder'));

	register('workUniverse.files.rename', async (arg?: unknown) => {
		const node = resolve(arg);
		if (!node || node.isRoot) {
			return;
		}
		const oldName = path.posix.basename(node.uri.path);
		const dot = node.isDirectory ? -1 : oldName.lastIndexOf('.');
		const name = await vscode.window.showInputBox({
			title: 'Rename',
			value: oldName,
			valueSelection: [0, dot > 0 ? dot : oldName.length],
			validateInput: validateSingleName,
		});
		if (!name || name.trim() === oldName) {
			return;
		}
		// A WorkspaceEdit lets language servers update imports, like the Explorer does.
		const edit = new vscode.WorkspaceEdit();
		edit.renameFile(node.uri, vscode.Uri.joinPath(node.uri, '..', name.trim()), { overwrite: false });
		if (!(await vscode.workspace.applyEdit(edit))) {
			vscode.window.showErrorMessage(`Could not rename to "${name}". Does it already exist?`);
		}
		targets.changed();
	});

	register('workUniverse.files.delete', async (arg?: unknown) => {
		const clicked = targets.fromArg(arg);
		const selection = targets.selected();
		// Like the Explorer: right-clicking inside the selection acts on the whole selection.
		const nodes = (
			clicked && !selection.some(s => sameUri(s.uri, clicked.uri)) ? [clicked] : selection.length ? selection : clicked ? [clicked] : []
		).filter(n => !n.isRoot);
		if (!nodes.length) {
			return;
		}
		const what = nodes.length === 1 ? `"${path.posix.basename(nodes[0].uri.path)}"` : `${nodes.length} items`;
		const choice = await vscode.window.showWarningMessage(
			`Delete ${what}?`,
			{ modal: true, detail: 'You can restore from the Recycle Bin / Trash.' },
			'Move to Trash',
		);
		if (choice !== 'Move to Trash') {
			return;
		}
		for (const n of nodes) {
			try {
				await vscode.workspace.fs.delete(n.uri, { recursive: true, useTrash: true });
			} catch (err) {
				vscode.window.showErrorMessage(`Could not delete ${n.uri.fsPath}: ${errorText(err)}`);
			}
		}
		targets.changed();
	});

	register('workUniverse.files.copyPath', async (arg?: unknown) => {
		const node = resolve(arg);
		if (node) {
			await vscode.env.clipboard.writeText(node.uri.fsPath);
		}
	});

	register('workUniverse.files.copyRelativePath', async (arg?: unknown) => {
		const node = resolve(arg);
		if (node) {
			await vscode.env.clipboard.writeText(path.relative(node.root.fsPath, node.uri.fsPath) || '.');
		}
	});

	register('workUniverse.files.revealInOS', (arg?: unknown) => {
		const node = resolve(arg) ?? rootTarget();
		return node && vscode.commands.executeCommand('revealFileInOS', node.uri);
	});

	register('workUniverse.files.openToSide', (arg?: unknown) => {
		const node = resolve(arg);
		return (
			node &&
			!node.isDirectory &&
			vscode.commands.executeCommand('vscode.open', node.uri, { viewColumn: vscode.ViewColumn.Beside, preview: false })
		);
	});

	register('workUniverse.files.openInTerminal', (arg?: unknown) => {
		const folder = folderOf(resolve(arg));
		if (folder) {
			vscode.window.createTerminal({ cwd: folder.uri, name: path.posix.basename(folder.uri.path) }).show();
		}
	});

	register('workUniverse.files.findInFolder', (arg?: unknown) => {
		const folder = folderOf(resolve(arg));
		if (folder) {
			vscode.commands.executeCommand('workbench.action.findInFiles', {
				filesToInclude: './' + vscode.workspace.asRelativePath(folder.uri, true),
			});
		}
	});

	/** Moves files/folders into `target` (drag and drop in the tree). */
	register('workUniverse.files.move', async (sources: vscode.Uri[], target: vscode.Uri) => {
		const edit = new vscode.WorkspaceEdit();
		let count = 0;
		for (const src of sources) {
			const dest = vscode.Uri.joinPath(target, path.posix.basename(src.path));
			const parent = vscode.Uri.joinPath(src, '..');
			const intoItself = dest.toString().toLowerCase().startsWith(src.toString().toLowerCase() + '/');
			if (sameUri(parent, target) || sameUri(src, target) || intoItself) {
				continue;
			}
			edit.renameFile(src, dest, { overwrite: false });
			count++;
		}
		if (count && !(await vscode.workspace.applyEdit(edit))) {
			vscode.window.showErrorMessage('Could not move: a file with the same name may already exist.');
		}
		targets.changed();
	});
}
