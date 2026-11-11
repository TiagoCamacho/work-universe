/**
 * Script of the Work Universe panel webview (tab strip, action buttons, file tree).
 *
 * Kept as raw text: it runs in the webview, not in the extension host. Rules for editing it:
 * no backticks and no "${" (this is a String.raw template), plain browser JavaScript only.
 *
 * Performance notes:
 * - Every workspace keeps its own tree (nodes, expanded folders, selection, scroll, decorations)
 *   in "caches". Switching to a workspace seen before shows its tree at once and re-reads the
 *   folders in the background.
 * - Clicking a tab switches the panel immediately; the host confirms (or reverts) afterwards.
 * - Folders are requested in one "listMany" message and answered in one "childrenMany" message.
 * - Only the rows in view are in the DOM (fixed row height, see ROW).
 */
export const PANEL_SCRIPT = String.raw`
(() => {
	const vscode = acquireVsCodeApi();
	const stripEl = document.getElementById('strip');
	const actionsEl = document.getElementById('actions');
	const treeEl = document.getElementById('tree');
	const iconStyle = document.getElementById('icon-theme');

	const ROW = 22;          // px, must match --row in the CSS
	const BUFFER = 12;       // extra rows rendered above and below the visible area
	const MAX_CACHED = 20;   // workspaces whose tree is kept in memory
	const raf = window.requestAnimationFrame ? cb => window.requestAnimationFrame(cb) : cb => setTimeout(cb, 0);

	let state = null;

	// ---- tree of the workspace on screen (identified by currentKey) ----
	/** key -> { key, uri, name, dir, icon, iconOpen, parent, children: string[] | null, isRoot, root } */
	let nodes = new Map();
	let roots = [];
	let rootKeys = [];
	let expanded = new Set();
	let selected = new Set();
	let focusKey = null;
	let anchorKey = null;
	let decorations = {};
	let currentKey = null;
	/** URIs of remembered expanded folders that have no node yet (first visit after a reload). */
	let rememberedUri = new Map();

	/** workspaceKey -> the variables above, plus scrollTop and the action buttons. */
	const caches = new Map();

	let visible = [];
	let indexOf = new Map();
	let pendingReveal = null;
	let dragTabId = null;
	let dragFiles = null;
	const requested = new Set();

	const saved = vscode.getState() || { expanded: {} };
	const saveExpanded = () => {
		if (currentKey === null) return;
		const pairs = [];
		for (const k of expanded) {
			const n = nodes.get(k);
			const uri = n ? n.uri : rememberedUri.get(k);
			if (uri) pairs.push([k, uri]);
		}
		saved.expanded[currentKey] = pairs;
		vscode.setState(saved);
	};

	const el = (tag, props = {}, children = []) => {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (v === undefined || v === null) continue;
			if (k === 'class') node.className = v;
			else if (k === 'style') for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
			else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
			else if (k === 'dataset') Object.assign(node.dataset, v);
			else node.setAttribute(k, v);
		}
		for (const c of [].concat(children)) if (c !== null && c !== undefined) node.append(c);
		return node;
	};
	const codicon = name => el('i', { class: 'codicon codicon-' + name, 'aria-hidden': 'true' });

	// ---------------------------------------------------------------- tabs
	function renderStrip() {
		stripEl.replaceChildren();
		if (!state || !state.inUniverse) { stripEl.className = ''; return; }
		stripEl.className = 'strip';
		stripEl.setAttribute('role', 'tablist');
		for (const tab of state.tabs) {
			stripEl.append(el('button', {
				class: 'tab' + (tab.active ? ' active' : ''),
				role: 'tab',
				'aria-selected': String(tab.active),
				title: tab.name + (tab.active ? ' (active)' : ''),
				draggable: 'true',
				style: tab.color ? { '--tab-color': tab.color } : {},
				dataset: { vscodeContext: JSON.stringify({ webviewSection: 'tab', workspaceId: tab.id, preventDefaultContextMenuItems: true }) },
				onclick: () => {
					if (tab.active) return;
					switchNow(tab.id);
					vscode.postMessage({ type: 'switch', workspaceId: tab.id });
				},
				ondragstart: e => { dragTabId = tab.id; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; },
				ondragend: e => { dragTabId = null; e.currentTarget.classList.remove('dragging'); },
				ondragover: e => { if (dragTabId && dragTabId !== tab.id) { e.preventDefault(); e.currentTarget.classList.add('drop-before'); } },
				ondragleave: e => e.currentTarget.classList.remove('drop-before'),
				ondrop: e => {
					e.preventDefault();
					e.currentTarget.classList.remove('drop-before');
					if (!dragTabId || dragTabId === tab.id) return;
					const ids = state.tabs.map(t => t.id).filter(id => id !== dragTabId);
					ids.splice(ids.indexOf(tab.id), 0, dragTabId);
					vscode.postMessage({ type: 'reorder', workspaceIds: ids });
				},
			}, [codicon(tab.icon), el('span', { class: 'name' }, tab.name)]));
		}
		stripEl.append(el('button', { class: 'tool', title: 'Add workspace folder', 'aria-label': 'Add workspace folder', onclick: () => vscode.postMessage({ type: 'add' }) }, codicon('add')));
		stripEl.append(el('span', { class: 'spacer' }));
		// Shows which mode the universe is in; click to change it.
		const together = state.mode === 'together';
		stripEl.append(el('button', {
			class: 'tool mode' + (together ? ' on' : ''),
			title: (together
				? 'Mode: All together. Every project stays loaded, switching only swaps tabs.'
				: 'Mode: Separate environments. Only the active project is loaded.') + ' Click to change.',
			'aria-label': together ? 'Mode: all together. Change mode' : 'Mode: separate environments. Change mode',
			onclick: () => vscode.postMessage({ type: 'mode' }),
		}, codicon(together ? 'layers' : 'lock')));
		if (state.tabs.length > 1) {
			stripEl.append(el('button', {
				class: 'tool' + (state.allMode ? ' on' : ''),
				title: state.mode === 'together' ? 'Search all workspaces of the universe' : 'Search whole universe (loads every workspace)',
				'aria-label': 'Search whole universe',
				onclick: () => vscode.postMessage({ type: 'searchAll' }),
			}, codicon('search')));
		}
	}

	/**
	 * Shows the clicked workspace right away, without waiting for the host. A workspace shown
	 * before comes complete from the cache (tree and action buttons); a new one starts loading its
	 * files at once. The host's next state message confirms it, or puts the previous workspace
	 * back if the switch is cancelled.
	 */
	function switchNow(id) {
		const cached = caches.get(id);
		const tab = state.tabs.find(t => t.id === id);
		for (const t of state.tabs) t.active = t.id === id;
		state.allMode = false;
		const newRoots = cached ? cached.roots : tab && tab.root ? [tab.root] : null;
		if (newRoots) {
			state.workspaceKey = id;
			state.activeWorkspaceId = id;
			state.roots = newRoots;
			state.actions = cached ? cached.actions || [] : [];
			state.activeColor = cached ? cached.activeColor : undefined;
			showWorkspace(id, newRoots);
		}
		renderStrip();
		renderActions();
		// Lets the host log how long after the click the panel was actually drawn.
		raf(() => vscode.postMessage({ type: 'painted' }));
	}

	function renderActions() {
		actionsEl.replaceChildren();
		const actions = (state && state.inUniverse && state.actions) || [];
		actionsEl.classList.toggle('hidden', !actions.length);
		for (const a of actions) {
			// While running, the icon takes the file's "active_color" (if set); otherwise its own color.
			const color = a.running && state.activeColor ? state.activeColor : a.color;
			actionsEl.append(el('button', {
				class: 'act' + (a.running ? ' running' : ''),
				title: a.label + (a.running ? ' (running)' : '') + (a.detail ? ' — ' + a.detail : ''),
				'aria-label': a.label + (a.running ? ', running' : ''),
				'aria-pressed': a.running ? 'true' : undefined,
				style: color ? { '--act-color': color } : {},
				dataset: { vscodeContext: JSON.stringify({ webviewSection: 'action', workspaceId: state.activeWorkspaceId, preventDefaultContextMenuItems: true }) },
				onclick: () => vscode.postMessage({ type: 'runAction', index: a.index }),
			}, codicon(a.icon)));
		}
		if (actions.length) {
			actionsEl.append(el('button', {
				class: 'act edit',
				title: 'Custom actions: edit or remove all',
				'aria-label': 'Custom actions menu',
				dataset: { vscodeContext: JSON.stringify({ webviewSection: 'action', workspaceId: state.activeWorkspaceId, preventDefaultContextMenuItems: true }) },
				// Open the native context menu (Set Custom Actions / Remove All) right under the button.
				onclick: e => {
					const r = e.currentTarget.getBoundingClientRect();
					e.preventDefault();
					e.stopPropagation();
					e.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left, clientY: r.bottom }));
				},
			}, codicon('gear')));
		}
	}

	function renderUniverses() {
		const box = el('div', { class: 'universes' });
		if (!state.universes.length) {
			box.append(el('div', { class: 'hint' }, 'Group your project folders into a universe and switch between them with tabs.'));
		} else {
			box.append(el('div', { class: 'hint' }, 'Open a universe in this window:'));
			for (const u of state.universes) {
				box.append(el('button', { class: 'urow', title: 'Open ' + u.name, onclick: () => vscode.postMessage({ type: 'openUniverse', universeId: u.id }) },
					[codicon('globe'), el('span', {}, u.name), el('span', { class: 'count' }, String(u.count))]));
			}
		}
		box.append(el('button', { class: 'primary', onclick: () => vscode.postMessage({ type: 'create' }) }, 'Create Universe'));
		treeEl.replaceChildren(box);
	}

	// ---------------------------------------------------------------- tree data
	const single = () => rootKeys.length === 1;
	const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

	/** Asks the host for the content of several folders in one message. */
	function requestMany(items) {
		const fresh = items.filter(i => i && i.uri && !requested.has(i.key));
		if (!fresh.length) return;
		for (const i of fresh) requested.add(i.key);
		vscode.postMessage({ type: 'listMany', items: fresh.map(i => ({ key: i.key, uri: i.uri, root: i.root })) });
	}
	const itemOf = node => ({ key: node.key, uri: node.uri, root: node.root });

	function isReachable(node) {
		let n = node;
		while (n && !n.isRoot) { if (!expanded.has(n.parent)) return false; n = nodes.get(n.parent); }
		return !!n;
	}

	/** Folders whose content is on screen (expanded and loaded). */
	function loadedFolders() {
		const result = [];
		for (const node of nodes.values()) {
			if (node.dir && node.children !== null && expanded.has(node.key) && isReachable(node)) result.push(node);
		}
		return result;
	}

	function stash() {
		if (currentKey === null) return;
		caches.delete(currentKey);
		caches.set(currentKey, {
			nodes, roots, rootKeys, expanded, selected, focusKey, anchorKey, decorations, rememberedUri,
			scrollTop: treeEl.scrollTop,
			actions: state ? state.actions : [],
			activeColor: state ? state.activeColor : undefined,
		});
		while (caches.size > MAX_CACHED) caches.delete(caches.keys().next().value);
	}

	/**
	 * Puts a workspace's tree on screen. Returns false if it already is. A workspace shown before
	 * comes straight from the cache and is re-read in the background; a new one is requested with
	 * all its remembered expanded folders at once.
	 */
	function showWorkspace(key, newRoots) {
		const newKeys = newRoots.map(r => r.key);
		if (currentKey === key && sameKeys(rootKeys, newKeys)) {
			roots = newRoots;
			for (const r of newRoots) { const n = nodes.get(r.key); if (n) Object.assign(n, { name: r.name, icon: r.icon, iconOpen: r.iconOpen }); }
			return false;
		}
		stash();
		currentKey = key;
		requested.clear();
		pendingReveal = null;
		const cached = caches.get(key);
		if (cached && sameKeys(cached.rootKeys, newKeys)) {
			({ nodes, rootKeys, expanded, selected, focusKey, anchorKey, decorations, rememberedUri } = cached);
			roots = newRoots;
			for (const r of newRoots) { const n = nodes.get(r.key); if (n) Object.assign(n, { name: r.name, icon: r.icon, iconOpen: r.iconOpen }); }
			rebuild();
			paint(true);
			treeEl.scrollTop = cached.scrollTop || 0;
			paint(true);
			// Show the cached tree now, bring it up to date in the background.
			const stale = loadedFolders();
			for (const n of stale) requested.delete(n.key);
			requestMany(stale.map(itemOf));
			return true;
		}

		nodes = new Map();
		roots = newRoots;
		rootKeys = newKeys;
		selected = new Set();
		focusKey = anchorKey = null;
		decorations = {};
		rememberedUri = new Map();
		for (const r of newRoots) {
			nodes.set(r.key, { key: r.key, uri: r.uri, name: r.name, dir: true, icon: r.icon, iconOpen: r.iconOpen, parent: null, children: null, isRoot: true, root: r.uri });
		}
		const remembered = saved.expanded[key];
		expanded = new Set();
		for (const entry of remembered || []) {
			if (Array.isArray(entry)) { expanded.add(entry[0]); rememberedUri.set(entry[0], entry[1]); }
			else expanded.add(entry); // older format: keys only, loaded level by level
		}
		if (!remembered) for (const k of rootKeys) expanded.add(k);
		if (single()) expanded.add(rootKeys[0]);

		// One request for the roots and every remembered expanded folder below them.
		const items = [];
		for (const k of rootKeys) if (expanded.has(k)) items.push(itemOf(nodes.get(k)));
		for (const [k, uri] of rememberedUri) {
			if (nodes.has(k)) continue;
			const root = newRoots.find(r => k.startsWith(r.key + '/'));
			if (root) items.push({ key: k, uri, root: root.uri });
		}
		requestMany(items);
		rebuild();
		paint(true);
		treeEl.scrollTop = 0;
		return true;
	}

	/** Stores a folder's rows. Returns false if the folder isn't part of the tree (any more). */
	function applyChildren(key, rows) {
		requested.delete(key);
		const parent = nodes.get(key);
		if (!parent) return false;
		parent.children = rows.map(r => {
			const existing = nodes.get(r.key);
			const node = Object.assign(existing || { children: null }, r, { parent: key, isRoot: false, root: parent.root });
			if (!existing || existing.dir !== r.dir) node.children = null;
			nodes.set(r.key, node);
			return r.key;
		});
		const present = new Set(parent.children);
		for (const k of [...selected]) {
			const n = nodes.get(k);
			if (n && n.parent === key && !present.has(k)) selected.delete(k);
		}
		return true;
	}

	function onChildrenMany(lists) {
		// Parents before children, so a remembered sub-folder finds its node.
		lists.sort((a, b) => a.key.length - b.key.length);
		for (const list of lists) {
			if (!applyChildren(list.key, list.rows)) { expanded.delete(list.key); rememberedUri.delete(list.key); }
		}
		// Expanded folders that became visible but aren't loaded yet (older saved state, reveal).
		const missing = [];
		for (const node of nodes.values()) {
			if (node.dir && node.children === null && expanded.has(node.key) && isReachable(node)) missing.push(itemOf(node));
		}
		requestMany(missing);
		rebuild();
		paint(true);
		tryReveal();
	}

	/** Re-reads folders after files were created or deleted: only the given ones, or all on screen. */
	function refresh(keys) {
		let targets = loadedFolders();
		if (keys) { const wanted = new Set(keys); targets = targets.filter(n => wanted.has(n.key)); }
		for (const n of targets) requested.delete(n.key);
		requestMany(targets.map(itemOf));
	}

	function toggle(node, open) {
		if (!node || !node.dir) return;
		const willOpen = open === undefined ? !expanded.has(node.key) : open;
		if (willOpen) { expanded.add(node.key); if (node.children === null) requestMany([itemOf(node)]); }
		else expanded.delete(node.key);
		saveExpanded();
		rebuild();
		paint(true);
	}

	// ---------------------------------------------------------------- tree render
	const spacer = el('div', { class: 'vspace' });
	const rowsEl = el('div', { class: 'vrows' });
	spacer.append(rowsEl);
	let paintedFirst = -1;
	let paintedLast = -1;

	/** Recomputes the flat list of rows (call when folders open, close or change). */
	function rebuild() {
		visible = [];
		indexOf = new Map();
		const walk = (keys, depth) => {
			for (const k of keys) {
				const n = nodes.get(k);
				if (!n) continue;
				indexOf.set(k, visible.length);
				visible.push({ node: n, depth });
				if (n.dir && expanded.has(k) && n.children) walk(n.children, depth + 1);
			}
		};
		if (single()) {
			const root = nodes.get(rootKeys[0]);
			if (root && root.children) walk(root.children, 0);
		} else {
			walk(rootKeys, 0);
		}
	}

	const viewHeight = () => treeEl.clientHeight || 600;

	/** Draws the rows in view. With force=false it does nothing if the same rows are already drawn. */
	function paint(force) {
		if (!state) return;
		if (!state.inUniverse) { renderUniverses(); paintedFirst = paintedLast = -1; return; }
		if (!visible.length) {
			const root = nodes.get(rootKeys[0]);
			// Nothing is shown while the first listing is on its way (it takes a few milliseconds).
			treeEl.replaceChildren(root && root.children ? el('div', { class: 'empty' }, 'This folder is empty.') : '');
			paintedFirst = paintedLast = -1;
			return;
		}
		const first = Math.max(0, Math.floor(treeEl.scrollTop / ROW) - BUFFER);
		const last = Math.min(visible.length, Math.ceil((treeEl.scrollTop + viewHeight()) / ROW) + BUFFER);
		if (!force && first === paintedFirst && last === paintedLast) return;
		paintedFirst = first;
		paintedLast = last;
		const frag = document.createDocumentFragment();
		for (let i = first; i < last; i++) frag.append(renderRow(visible[i].node, visible[i].depth));
		rowsEl.replaceChildren(frag);
		rowsEl.style.transform = 'translateY(' + (first * ROW) + 'px)';
		spacer.style.height = (visible.length * ROW) + 'px';
		if (spacer.parentNode !== treeEl || treeEl.childNodes.length !== 1) treeEl.replaceChildren(spacer);
	}

	let scrollQueued = false;
	treeEl.addEventListener('scroll', () => {
		if (scrollQueued) return;
		scrollQueued = true;
		raf(() => { scrollQueued = false; paint(false); });
	});
	window.addEventListener('resize', () => paint(false));

	/** Scrolls just enough to bring a row into view. */
	function ensureVisible(key) {
		const i = indexOf.get(key);
		if (i === undefined) return;
		const top = i * ROW;
		const h = viewHeight();
		if (top < treeEl.scrollTop) treeEl.scrollTop = top;
		else if (top + ROW > treeEl.scrollTop + h) treeEl.scrollTop = top + ROW - h;
		paint(false);
	}

	function renderRow(node, depth) {
		const isOpen = node.dir && expanded.has(node.key);
		const deco = decorations[node.key];
		const iconClass = node.dir ? (isOpen ? node.iconOpen || node.icon : node.icon) : node.icon;
		let icon;
		if (state.hasIconTheme) {
			icon = el('span', { class: 'ic ' + (iconClass || 'none'), 'aria-hidden': 'true' });
		} else {
			icon = el('span', { class: 'ic', 'aria-hidden': 'true' }, codicon(node.isRoot ? 'root-folder' : node.dir ? (isOpen ? 'folder-opened' : 'folder') : 'file'));
		}
		const showTwistie = node.dir && !state.hidesArrows;
		const row = el('div', {
			class: 'row' + (selected.has(node.key) ? ' selected' : '') + (focusKey === node.key ? ' focused' : '') + (deco && deco.faded ? ' faded' : ''),
			role: 'treeitem',
			'aria-level': String(depth + 1),
			'aria-expanded': node.dir ? String(isOpen) : undefined,
			'aria-selected': String(selected.has(node.key)),
			title: deco && deco.tooltip ? node.name + ' · ' + deco.tooltip : node.name,
			draggable: node.isRoot ? undefined : 'true',
			style: { 'padding-left': (depth * 8 + 4) + 'px' },
			dataset: {
				key: node.key,
				vscodeContext: JSON.stringify({ webviewSection: node.isRoot ? 'root' : node.dir ? 'folder' : 'file', uri: node.uri, root: node.root, preventDefaultContextMenuItems: true }),
			},
		});
		for (let i = 0; i < depth; i++) row.append(el('span', { class: 'guide', style: { left: (i * 8 + 12) + 'px' } }));
		row.append(el('span', { class: 'twistie' }, showTwistie ? codicon(isOpen ? 'chevron-down' : 'chevron-right') : null));
		row.append(icon);
		row.append(el('span', { class: 'label', style: deco && deco.color ? { color: deco.color } : {} }, node.name));
		if (deco && deco.badge) row.append(el('span', { class: 'badge', style: deco.color ? { color: deco.color } : {} }, deco.badge));
		return row;
	}

	// ---------------------------------------------------------------- selection
	const target = n => ({ uri: n.uri, root: n.root, dir: n.dir, isRoot: n.isRoot });
	function postSelection() {
		vscode.postMessage({ type: 'select', items: [...selected].map(k => nodes.get(k)).filter(Boolean).map(target) });
	}
	function select(key, mode) {
		if (mode === 'toggle') {
			selected.has(key) ? selected.delete(key) : selected.add(key);
			anchorKey = key;
		} else if (mode === 'range' && anchorKey) {
			const a = indexOf.get(anchorKey), b = indexOf.get(key);
			if (a !== undefined && b !== undefined) {
				selected = new Set(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map(v => v.node.key));
			}
		} else {
			selected = new Set([key]);
			anchorKey = key;
		}
		focusKey = key;
		postSelection();
		paint(true);
		if (document.activeElement === treeEl) ensureVisible(key);
	}
	function open(node, preview) {
		if (node && !node.dir) vscode.postMessage({ type: 'open', uri: node.uri, preview });
	}
	const rowNode = e => { const row = e.target.closest('.row'); return row ? nodes.get(row.dataset.key) : null; };

	treeEl.addEventListener('click', e => {
		const node = rowNode(e);
		if (!node) return;
		if (e.ctrlKey || e.metaKey) return select(node.key, 'toggle');
		if (e.shiftKey) return select(node.key, 'range');
		select(node.key);
		if (node.dir) toggle(node);
		else open(node, true);
	});
	treeEl.addEventListener('dblclick', e => {
		const node = rowNode(e);
		if (node && !node.dir) open(node, false);
	});
	treeEl.addEventListener('contextmenu', e => {
		const node = rowNode(e);
		if (node && !selected.has(node.key)) select(node.key);
	});

	treeEl.addEventListener('keydown', e => {
		if (!state || !state.inUniverse || !visible.length) return;
		const i = focusKey !== null && indexOf.has(focusKey) ? indexOf.get(focusKey) : -1;
		const node = focusKey ? nodes.get(focusKey) : null;
		const page = Math.max(1, Math.floor(viewHeight() / ROW) - 1);
		const move = idx => { idx = Math.max(0, Math.min(visible.length - 1, idx)); select(visible[idx].node.key, e.shiftKey ? 'range' : undefined); };
		switch (e.key) {
			case 'ArrowDown': e.preventDefault(); move(i < 0 ? 0 : i + 1); break;
			case 'ArrowUp': e.preventDefault(); move(i < 0 ? 0 : i - 1); break;
			case 'Home': e.preventDefault(); move(0); break;
			case 'End': e.preventDefault(); move(visible.length - 1); break;
			case 'PageDown': e.preventDefault(); move(i + page); break;
			case 'PageUp': e.preventDefault(); move(i - page); break;
			case 'ArrowRight':
				e.preventDefault();
				if (node && node.dir) { if (!expanded.has(node.key)) toggle(node, true); else if (node.children && node.children.length) select(node.children[0]); }
				break;
			case 'ArrowLeft':
				e.preventDefault();
				if (node && node.dir && expanded.has(node.key)) toggle(node, false);
				else if (node && node.parent && indexOf.has(node.parent)) select(node.parent);
				break;
			case 'Enter':
				e.preventDefault();
				if (node) node.dir ? toggle(node) : open(node, false);
				break;
			case ' ':
				e.preventDefault();
				if (node) node.dir ? toggle(node) : open(node, true);
				break;
			case 'F2':
				e.preventDefault();
				if (node && !node.isRoot) vscode.postMessage({ type: 'command', id: 'workUniverse.files.rename', target: target(node) });
				break;
			case 'Delete':
			case 'Backspace':
				if (e.key === 'Backspace' && !e.metaKey) break;
				e.preventDefault();
				if (node) vscode.postMessage({ type: 'command', id: 'workUniverse.files.delete' });
				break;
			case 'Escape':
				selected.clear(); postSelection(); paint(true); break;
		}
	});
	treeEl.addEventListener('focus', () => {
		if (!focusKey && visible.length) { focusKey = visible[0].node.key; paint(true); }
	});

	// ---------------------------------------------------------------- drag & drop of files
	const dropDirFor = node => {
		if (!node) return nodes.get(rootKeys[0]);
		return node.dir ? node : nodes.get(node.parent);
	};
	let dropRow = null;
	const clearDrop = () => { if (dropRow) dropRow.classList.remove('drop-target'); dropRow = null; };
	treeEl.addEventListener('dragstart', e => {
		const node = rowNode(e);
		if (!node || node.isRoot) return;
		const keys = selected.has(node.key) ? [...selected] : [node.key];
		dragFiles = keys.map(k => nodes.get(k)).filter(n => n && !n.isRoot);
		e.dataTransfer.effectAllowed = 'copyMove';
		e.dataTransfer.setData('text/uri-list', dragFiles.map(n => n.uri).join('\r\n'));
		e.dataTransfer.setData('text/plain', dragFiles.map(n => n.uri).join('\n'));
	});
	treeEl.addEventListener('dragend', () => { dragFiles = null; clearDrop(); });
	treeEl.addEventListener('dragover', e => {
		if (!dragFiles) return;
		const dir = dropDirFor(rowNode(e));
		if (!dir) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		const row = treeEl.querySelector('.row[data-key="' + CSS.escape(dir.key) + '"]');
		if (row !== dropRow) { clearDrop(); dropRow = row; if (row) row.classList.add('drop-target'); }
	});
	treeEl.addEventListener('dragleave', e => { if (!treeEl.contains(e.relatedTarget)) clearDrop(); });
	treeEl.addEventListener('drop', e => {
		if (!dragFiles) return;
		e.preventDefault();
		const dir = dropDirFor(rowNode(e));
		clearDrop();
		if (dir) {
			expanded.add(dir.key);
			saveExpanded();
			vscode.postMessage({ type: 'move', sources: dragFiles.map(n => n.uri), target: dir.uri });
		}
		dragFiles = null;
	});

	// ---------------------------------------------------------------- reveal
	function tryReveal() {
		if (!pendingReveal) return;
		const { key, chain, rootKey } = pendingReveal;
		if (!nodes.has(rootKey)) { pendingReveal = null; return; }
		for (const link of [{ key: rootKey }, ...chain]) {
			const n = nodes.get(link.key);
			if (!n) {
				// The parent's listing is still on its way; give up if nothing is pending.
				if (!requested.size) pendingReveal = null;
				return;
			}
			expanded.add(n.key);
			if (n.children === null) { requestMany([itemOf(n)]); return; }
		}
		if (!nodes.has(key)) { pendingReveal = null; return; } // excluded or not listed
		pendingReveal = null;
		saveExpanded();
		selected = new Set([key]);
		focusKey = anchorKey = key;
		postSelection();
		rebuild();
		paint(true);
		ensureVisible(key);
	}

	// ---------------------------------------------------------------- messages
	window.addEventListener('message', e => {
		const msg = e.data;
		switch (msg && msg.type) {
			case 'state': {
				state = msg;
				const changed = state.inUniverse ? showWorkspace(state.workspaceKey, state.roots) : (stash(), currentKey = null, true);
				renderStrip();
				renderActions();
				paint(true);
				if (changed) raf(() => vscode.postMessage({ type: 'painted' }));
				break;
			}
			case 'icons':
				iconStyle.textContent = msg.append ? iconStyle.textContent + '\n' + msg.css : msg.css;
				break;
			case 'childrenMany': onChildrenMany(msg.lists); break;
			case 'refresh': refresh(msg.keys); break;
			case 'decorations': {
				const map = msg.map || {};
				if (msg.workspaceKey === undefined || msg.workspaceKey === currentKey) { decorations = map; paint(true); }
				else { const c = caches.get(msg.workspaceKey); if (c) c.decorations = map; }
				break;
			}
			case 'collapseAll':
				expanded = new Set(single() ? rootKeys : []);
				saveExpanded();
				rebuild();
				paint(true);
				break;
			case 'reveal': pendingReveal = msg; tryReveal(); break;
		}
	});
	vscode.postMessage({ type: 'ready' });
})();
`;
