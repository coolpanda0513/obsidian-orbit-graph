import { App, PluginSettingTab, Setting } from "obsidian";
import type OrbitGraphPlugin from "./main";
import { CenterMode, DEFAULT_SETTINGS } from "./types";

export class OrbitSettingTab extends PluginSettingTab {
	private plugin: OrbitGraphPlugin;

	constructor(app: App, plugin: OrbitGraphPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Solar system").setHeading();

		new Setting(containerEl)
			.setName("Center of the system")
			.setDesc("Which note becomes the sun. Linked notes orbit around it, ordered by how many links away they are.")
			.addDropdown((d) =>
				d
					.addOption("active", "The note you have open")
					.addOption("hub", "Your most-linked note")
					.setValue(s.centerMode)
					.onChange(async (v) => {
						s.centerMode = v as CenterMode;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Number of orbits")
			.setDesc("Notes further away than this share the outermost orbit.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 10, 1)
					.setValue(s.maxOrbits)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.maxOrbits = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Show unlinked notes")
			.setDesc("Notes that can't be reached from the sun drift in an outer asteroid belt.")
			.addToggle((t) =>
				t.setValue(s.showOrphans).onChange(async (v) => {
					s.showOrphans = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder path per line. Notes inside these folders are left out of the universe.")
			.addTextArea((t) =>
				t
					.setPlaceholder("Templates\nArchive/Old")
					.setValue(s.excludeFolders)
					.onChange(async (v) => {
						s.excludeFolders = v;
						await save();
					}),
			);

		new Setting(containerEl).setName("Motion & camera").setHeading();

		new Setting(containerEl)
			.setName("Orbit speed")
			.setDesc("0 freezes the orbits in place.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 3, 0.1)
					.setValue(s.orbitSpeed)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.orbitSpeed = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Camera tilt")
			.setDesc("Degrees. 0 looks straight down on the system. You can also shift-drag in the view.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 75, 1)
					.setValue(s.tilt)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.tilt = v;
						await save();
					}),
			);

		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl).setName("Show orbit paths").addToggle((t) =>
			t.setValue(s.showOrbits).onChange(async (v) => {
				s.showOrbits = v;
				await save();
			}),
		);

		new Setting(containerEl).setName("Show links").addToggle((t) =>
			t.setValue(s.showLinks).onChange(async (v) => {
				s.showLinks = v;
				await save();
			}),
		);

		new Setting(containerEl).setName("Link brightness").addSlider((sl) =>
			sl
				.setLimits(0, 1, 0.05)
				.setValue(s.linkOpacity)
				.setDynamicTooltip()
				.onChange(async (v) => {
					s.linkOpacity = v;
					await save();
				}),
		);

		new Setting(containerEl)
			.setName("Signals")
			.setDesc("Little pulses of light that travel along links.")
			.addToggle((t) =>
				t.setValue(s.showSignals).onChange(async (v) => {
					s.showSignals = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Glow intensity")
			.addSlider((sl) =>
				sl
					.setLimits(0, 2, 0.1)
					.setValue(s.glowIntensity)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.glowIntensity = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Star density")
			.setDesc("Background stars and the occasional shooting star. 0 turns them off.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 2, 0.1)
					.setValue(s.starDensity)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.starDensity = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Label size threshold")
			.setDesc("Planets bigger than this many pixels on screen get a name. Zoom in to see more. 0 labels everything.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 20, 1)
					.setValue(s.labelThreshold)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.labelThreshold = v;
						await save();
					}),
			);

		new Setting(containerEl).addButton((b) =>
			b.setButtonText("Reset to defaults").onClick(async () => {
				Object.assign(this.plugin.settings, DEFAULT_SETTINGS);
				await save();
				this.display();
			}),
		);
	}
}
