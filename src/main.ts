import { debounce, Plugin, WorkspaceLeaf } from "obsidian";
import { OrbitSettingTab } from "./settings";
import { DEFAULT_SETTINGS, OrbitSettings } from "./types";
import { OrbitView, VIEW_TYPE_ORBIT } from "./view";

export default class OrbitGraphPlugin extends Plugin {
	settings: OrbitSettings = { ...DEFAULT_SETTINGS };

	private refreshViews = debounce(
		() => {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ORBIT)) {
				if (leaf.view instanceof OrbitView) leaf.view.applySettings();
			}
		},
		150,
		true,
	);

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_ORBIT, (leaf) => new OrbitView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE_ORBIT, {
			display: "Orbit graph",
			defaultMod: true,
		});

		this.addRibbonIcon("orbit", "Open orbit graph", () => this.activateView("tab"));

		this.addCommand({
			id: "open",
			name: "Open orbit graph",
			callback: () => this.activateView("tab"),
		});
		this.addCommand({
			id: "open-sidebar",
			name: "Open orbit graph in sidebar",
			callback: () => this.activateView("sidebar"),
		});

		this.addSettingTab(new OrbitSettingTab(this.app, this));
	}

	async activateView(where: "tab" | "sidebar"): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_ORBIT)[0] ?? null;
		if (!leaf) {
			leaf = where === "sidebar" ? workspace.getRightLeaf(false) : workspace.getLeaf("tab");
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_ORBIT, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshViews();
	}
}
