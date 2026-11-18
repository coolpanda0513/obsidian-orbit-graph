export type CenterMode = "active" | "hub";

export interface OrbitSettings {
	/** Which note sits at the center of the system. */
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
	/** Faint points of light drifting along links. */
	showSignals: boolean;
	/** Show notes that aren't connected to the center on an outer ring. */
	showOrphans: boolean;
	/** Notes bigger than this (in screen pixels) get a label. 0 = label everything. */
	labelThreshold: number;
	/** Background stars and the Milky Way band. 0..2 */
	starDensity: number;
	/** 0..2 */
	glowIntensity: number;
	/** The color everything glows in. */
	accentColor: string;
	/** Long-exposure light trails behind every note. */
	trails: boolean;
	/** Dust drifting in the orbital plane. */
	dust: boolean;
	/** Lens bloom around bright light. */
	bloom: boolean;
	/** Subtle film grain and vignette. */
	filmGrain: boolean;
	/** Tilt the scene slightly toward the mouse. */
	parallax: boolean;
	/** One folder path per line. */
	excludeFolders: string;
}

export const DEFAULT_SETTINGS: OrbitSettings = {
	centerMode: "active",
	orbitSpeed: 1,
	tilt: 66,
	maxOrbits: 6,
	showOrbits: true,
	showLinks: true,
	linkOpacity: 0.4,
	showSignals: true,
	showOrphans: true,
	labelThreshold: 4.5,
	starDensity: 1,
	glowIntensity: 1,
	accentColor: "#dfe6f5",
	trails: true,
	dust: true,
	bloom: true,
	filmGrain: true,
	parallax: true,
	excludeFolders: "",
};
