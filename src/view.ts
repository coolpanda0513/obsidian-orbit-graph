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
import { OrbitRenderer } from "./renderer";

export const VIEW_TYPE_ORBIT = "orbit-graph-view";

export class OrbitView extends ItemView {
	hoverPopover: HoverPopover | null = null;

	private plugin: OrbitGraphPlugin;
	private renderer: OrbitRenderer | null = null;
	private graph: GraphData | null = null;
	private centerId: string | null = null;

	private canvasEl!: HTMLCanvasElement;
	private emptyEl!: HTMLElement;
	private searchEl!: HTMLInputElement;

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
		this.buildControls(root);
		this.emptyEl = root.createDiv({ cls: "orbit-graph-empty", text: "No notes yet" });

		const font = getComputedStyle(root).getPropertyValue("--font-interface").trim();
		this.renderer = new OrbitRenderer(
			this.canvasEl,
			this.plugin.settings,
			{
				onHover: (id, ev) => this.onHover(id, ev),
				onClick: (id, ev) => this.openNote(id, !!Keymap.isModEvent(ev)),
				onContextMenu: (id, ev) => this.showMenu(id, ev),
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

		if (this.centerId && !this.graph.byId.has(this.centerId)) this.centerId = null;
		if (!this.centerId && this.plugin.settings.centerMode === "active") {
			const active = this.app.workspace.getActiveFile()?.path;
			if (active && this.graph.byId.has(active)) this.centerId = active;
		}
		this.renderer.setGraph(this.graph, this.centerId ?? findHub(this.graph));
		this.emptyEl.toggleClass("is-visible", this.graph.nodes.length === 0);
		this.applySearch();
	}

	private setCenter(id: string | null): void {
		if (!this.graph || !id || !this.graph.byId.has(id)) return;
		this.centerId = id;
		this.renderer?.setCenter(id);
	}

	// ------------------------------------------------------------------ UI

	private buildControls(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "orbit-graph-controls" });
		this.searchEl = bar.createEl("input", {
			cls: "orbit-graph-search",
			type: "search",
			placeholder: "Search",
		});
		this.searchEl.addEventListener("input", () => this.applySearch());
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
			const b = bar.createEl("button", { cls: "orbit-graph-button", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("click", onClick);
		};
		button("locate-fixed", "Center on active note", () => {
			const f = this.app.workspace.getActiveFile();
			if (f) this.setCenter(f.path);
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
		if (!this.renderer) return;
		const q = this.searchEl.value.trim();
		this.renderer.setHighlight(q ? new Set(this.matches()) : null);
	}

	private onHover(id: string | null, ev: MouseEvent | null): void {
		if (!id || !ev) return;
		this.app.workspace.trigger("hover-link", {
			event: ev,
			source: VIEW_TYPE_ORBIT,
			hoverParent: this,
			targetEl: this.canvasEl,
			linktext: id,
			sourcePath: "",
		});
	}

	private showMenu(id: string, ev: MouseEvent): void {
		const file = this.app.vault.getAbstractFileByPath(id);
		if (!(file instanceof TFile)) return;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Open").setIcon("file-text").onClick(() => this.openNote(id, false)));
		menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.openNote(id, true)));
		menu.addItem((i) => i.setTitle("Move to center").setIcon("locate-fixed").onClick(() => this.setCenter(id)));
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
