import {
	debounce,
	HoverPopover,
	ItemView,
	Keymap,
	Menu,
	setIcon,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { buildGraph, findHub, GraphData, NoteInfo } from "./graph";
import type OrbitGraphPlugin from "./main";
import { assignFolderColors } from "./palette";
import { OrbitRenderer } from "./renderer";

export const VIEW_TYPE_ORBIT = "orbit-graph-view";

export class OrbitView extends ItemView {
	hoverPopover: HoverPopover | null = null;

	private plugin: OrbitGraphPlugin;
	private renderer: OrbitRenderer | null = null;
	private graph: GraphData | null = null;
	private folderColors = new Map<string, string>();
	private centerId: string | null = null;

	private canvasEl!: HTMLCanvasElement;
	private tooltipEl!: HTMLElement;
	private statsEl!: HTMLElement;
	private legendEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private legendFolder: string | null = null;

	private requestRebuild = debounce(() => this.rebuild(), 400, true);

	constructor(leaf: WorkspaceLeaf, plugin: OrbitGraphPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_ORBIT;
	}

	getDisplayText(): string {
		return "Orbit graph";
	}

	getIcon(): string {
		return "orbit";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("orbit-graph");

		this.canvasEl = root.createEl("canvas", { cls: "orbit-graph-canvas" });
		this.buildHud(root);
		this.tooltipEl = root.createDiv({ cls: "orbit-graph-tooltip" });
		this.statsEl = root.createDiv({ cls: "orbit-graph-stats" });
		this.legendEl = root.createDiv({ cls: "orbit-graph-legend" });
		this.emptyEl = root.createDiv({ cls: "orbit-graph-empty" });
		this.emptyEl.createDiv({ cls: "orbit-graph-empty-title", text: "An empty universe" });
		this.emptyEl.createDiv({ text: "Create a few notes and link them together to watch your galaxy form." });

		const font = getComputedStyle(root).getPropertyValue("--font-interface").trim();
		this.renderer = new OrbitRenderer(
			this.canvasEl,
			this.plugin.settings,
			{
				onHover: (id, x, y, ev) => this.onHover(id, x, y, ev),
				onClick: (id, ev) => this.openNote(id, !!Keymap.isModEvent(ev)),
				onContextMenu: (id, ev) => this.showMenu(id, ev),
				onLayout: () => this.updateStats(),
			},
			{ fontFamily: font || undefined },
		);

		this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestRebuild()));
		this.registerEvent(this.app.vault.on("create", () => this.requestRebuild()));
		this.registerEvent(this.app.vault.on("delete", () => this.requestRebuild()));
		this.registerEvent(this.app.vault.on("rename", () => this.requestRebuild()));
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (this.plugin.settings.centerMode === "active" && file) this.setCenter(file.path);
			}),
		);

		if (this.plugin.settings.centerMode === "active") {
			this.centerId = this.app.workspace.getActiveFile()?.path ?? null;
		}
		this.rebuild();
	}

	async onClose(): Promise<void> {
		this.renderer?.destroy();
		this.renderer = null;
	}

	/** Called by the plugin when settings change. */
	applySettings(): void {
		this.renderer?.updateSettings(this.plugin.settings);
		this.rebuild();
	}

	// ------------------------------------------------------------------ data

	private rebuild(): void {
		if (!this.renderer) return;
		const excluded = this.plugin.settings.excludeFolders
			.split("\n")
			.map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
			.filter(Boolean);
		const notes: NoteInfo[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (excluded.some((f) => file.path === f || file.path.startsWith(f + "/"))) continue;
			const slash = file.path.indexOf("/");
			notes.push({
				path: file.path,
				name: file.basename,
				folder: slash > 0 ? file.path.slice(0, slash) : "",
			});
		}
		notes.sort((a, b) => a.path.localeCompare(b.path));
		this.graph = buildGraph(notes, this.app.metadataCache.resolvedLinks);
		this.folderColors = assignFolderColors(this.graph.nodes);

		if (this.centerId && !this.graph.byId.has(this.centerId)) this.centerId = null;
		if (!this.centerId && this.plugin.settings.centerMode === "active") {
			const active = this.app.workspace.getActiveFile()?.path;
			if (active && this.graph.byId.has(active)) this.centerId = active;
		}
		this.renderer.setGraph(this.graph, this.folderColors, this.centerId ?? findHub(this.graph));

		this.emptyEl.toggleClass("is-visible", this.graph.nodes.length === 0);
		this.renderLegend();
		this.applySearch();
	}

	private setCenter(id: string | null): void {
		if (!this.graph || !id || !this.graph.byId.has(id)) return;
		this.centerId = id;
		this.renderer?.setCenter(id);
	}

	// ------------------------------------------------------------------ UI

	private buildHud(root: HTMLElement): void {
		const hud = root.createDiv({ cls: "orbit-graph-hud" });
		const search = hud.createDiv({ cls: "orbit-graph-search" });
		setIcon(search.createSpan({ cls: "orbit-graph-search-icon" }), "search");
		this.searchEl = search.createEl("input", {
			type: "search",
			placeholder: "Search the cosmos…",
		});
		this.searchEl.addEventListener("input", () => {
			this.legendFolder = null;
			this.applySearch();
			this.renderLegend();
		});
		this.searchEl.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				this.searchEl.value = "";
				this.applySearch();
			} else if (e.key === "Enter") {
				const first = this.matches()[0];
				if (first) this.setCenter(first);
			}
		});

		const button = (icon: string, label: string, onClick: () => void) => {
			const b = hud.createEl("button", { cls: "orbit-graph-button clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("click", onClick);
		};
		button("locate-fixed", "Center on active note", () => {
			const f = this.app.workspace.getActiveFile();
			if (f) this.setCenter(f.path);
		});
		button("sun", "Center on most-linked note", () => {
			if (this.graph) this.setCenter(findHub(this.graph));
		});
		button("maximize", "Fit to view", () => this.renderer?.fit());
	}

	private matches(): string[] {
		const q = this.searchEl?.value.trim().toLowerCase();
		if (!q || !this.graph) return [];
		return this.graph.nodes
			.filter((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
			.sort((a, b) => b.degree - a.degree)
			.map((n) => n.path);
	}

	private applySearch(): void {
		if (!this.renderer || !this.graph) return;
		if (this.legendFolder !== null) {
			const folder = this.legendFolder;
			this.renderer.setHighlight(new Set(this.graph.nodes.filter((n) => n.folder === folder).map((n) => n.path)));
			return;
		}
		const q = this.searchEl.value.trim();
		this.renderer.setHighlight(q ? new Set(this.matches()) : null);
	}

	private renderLegend(): void {
		const el = this.legendEl;
		el.empty();
		if (!this.graph || !this.graph.nodes.length) return;
		const counts = new Map<string, number>();
		for (const n of this.graph.nodes) counts.set(n.folder, (counts.get(n.folder) || 0) + 1);
		const folders = [...counts.keys()].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
		const shown = folders.slice(0, 8);
		for (const folder of shown) {
			const item = el.createDiv({ cls: "orbit-graph-legend-item" });
			if (this.legendFolder === folder) item.addClass("is-active");
			const dot = item.createSpan({ cls: "orbit-graph-dot" });
			dot.style.setProperty("--orbit-color", this.folderColors.get(folder) || "#fff");
			item.createSpan({ text: folder || "Vault root" });
			item.createSpan({ cls: "orbit-graph-legend-count", text: String(counts.get(folder)) });
			item.addEventListener("click", () => {
				this.legendFolder = this.legendFolder === folder ? null : folder;
				if (this.legendFolder !== null) this.searchEl.value = "";
				this.applySearch();
				this.renderLegend();
			});
		}
		if (folders.length > shown.length) {
			el.createDiv({ cls: "orbit-graph-legend-more", text: `+${folders.length - shown.length} more` });
		}
	}

	private updateStats(): void {
		if (!this.statsEl || !this.graph || !this.renderer) return;
		this.statsEl.empty();
		const centerId = this.renderer.getCenterId();
		const idx = centerId ? this.graph.byId.get(centerId) : undefined;
		if (idx !== undefined) {
			const sun = this.statsEl.createDiv({ cls: "orbit-graph-stats-center" });
			setIcon(sun.createSpan(), "sun");
			sun.createSpan({ text: this.graph.nodes[idx].name });
		}
		const n = this.graph.nodes.length;
		const e = this.graph.edges.length;
		const o = this.renderer.getOrbitCount();
		this.statsEl.createDiv({
			text: `${n.toLocaleString()} notes · ${e.toLocaleString()} links · ${o} orbit${o === 1 ? "" : "s"}`,
		});
	}

	private onHover(id: string | null, x: number, y: number, ev: MouseEvent | null): void {
		const tip = this.tooltipEl;
		if (!id || !this.graph) {
			tip.removeClass("is-visible");
			return;
		}
		const idx = this.graph.byId.get(id);
		if (idx === undefined) return;
		const node = this.graph.nodes[idx];
		tip.empty();
		const title = tip.createDiv({ cls: "orbit-graph-tooltip-title" });
		title.createSpan({ cls: "orbit-graph-dot" }).style.setProperty("--orbit-color", this.folderColors.get(node.folder) || "#fff");
		title.createSpan({ text: node.name });
		const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "Vault root";
		tip.createDiv({ cls: "orbit-graph-tooltip-path", text: parent });
		const orbit = this.renderer?.getOrbit(id);
		const where =
			orbit === 0 ? "The sun" : orbit === -1 ? "Outer belt" : orbit ? `Orbit ${orbit}` : "";
		tip.createDiv({
			cls: "orbit-graph-tooltip-meta",
			text: `${node.degree} link${node.degree === 1 ? "" : "s"}${where ? " · " + where : ""}`,
		});
		const maxX = this.contentEl.clientWidth - 240;
		tip.style.setProperty("--orbit-tip-x", `${Math.min(x + 16, Math.max(8, maxX))}px`);
		tip.style.setProperty("--orbit-tip-y", `${y + 16}px`);
		tip.addClass("is-visible");

		if (ev) {
			this.app.workspace.trigger("hover-link", {
				event: ev,
				source: VIEW_TYPE_ORBIT,
				hoverParent: this,
				targetEl: this.canvasEl,
				linktext: id,
				sourcePath: "",
			});
		}
	}

	private showMenu(id: string, ev: MouseEvent): void {
		const file = this.app.vault.getAbstractFileByPath(id);
		if (!(file instanceof TFile)) return;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => this.openNote(id, false)));
		menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.openNote(id, true)));
		menu.addItem((i) =>
			i.setTitle("Make this the sun").setIcon("sun").onClick(() => this.setCenter(id)),
		);
		this.app.workspace.trigger("file-menu", menu, file, "orbit-graph", this.leaf);
		menu.showAtMouseEvent(ev);
	}

	private openNote(id: string, newTab: boolean): void {
		const file = this.app.vault.getAbstractFileByPath(id);
		if (!(file instanceof TFile)) return;
		let leaf: WorkspaceLeaf | null = null;
		if (!newTab) {
			// Reuse an existing editor instead of replacing the orbit view itself.
			const recent = this.app.workspace.getMostRecentLeaf();
			if (recent && recent !== this.leaf && recent.view.getViewType() === "markdown") leaf = recent;
			else leaf = this.app.workspace.getLeavesOfType("markdown")[0] ?? null;
		}
		if (!leaf) leaf = this.app.workspace.getLeaf("tab");
		void leaf.openFile(file);
	}
}
