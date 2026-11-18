export type CenterMode = "active" | "hub";

export interface OrbitSettings {
	/** Which note sits at the center of the solar system. */
	centerMode: CenterMode;
	/** Multiplier for orbital speed. 0 freezes the orbits. */
	orbitSpeed: number;
	/** Camera tilt in degrees (0 = looking straight down). */
	tilt: number;
	/** Notes further than this many links away share the outermost orbit. */
	maxOrbits: number;
	showOrbits: boolean;
	showLinks: boolean;
	/** 0..1 */
	linkOpacity: number;
	/** Little light particles travelling along links. */
	showSignals: boolean;
	/** Show notes that aren't connected to the center as an outer asteroid belt. */
	showOrphans: boolean;
	/** Notes bigger than this (in screen pixels) get a label. 0 = label everything. */
	labelThreshold: number;
	/** 0..2 */
	starDensity: number;
	/** 0..2 */
	glowIntensity: number;
	/** The single color everything glows in. */
	accentColor: string;
	/** One folder path per line. */
	excludeFolders: string;
}

export const DEFAULT_SETTINGS: OrbitSettings = {
	centerMode: "active",
	orbitSpeed: 1,
	tilt: 62,
	maxOrbits: 6,
	showOrbits: true,
	showLinks: true,
	linkOpacity: 0.5,
	showSignals: true,
	showOrphans: true,
	labelThreshold: 4,
	starDensity: 0.6,
	glowIntensity: 1,
	accentColor: "#dfe6f5",
	excludeFolders: "",
};
