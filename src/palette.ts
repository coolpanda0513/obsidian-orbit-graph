import type { GraphNode } from "./graph";

/** Neon, space-y colors assigned to top-level folders, most-used folder first. */
export const PALETTE = [
	"#5ee7ff", // cyan
	"#b388ff", // violet
	"#ff6ec7", // pink
	"#ffd166", // gold
	"#7cffb2", // mint
	"#ff8a5b", // orange
	"#6c9bff", // blue
	"#f5a3ff", // lilac
	"#4dffd2", // aqua
	"#ff5e7e", // rose
	"#c6ff6b", // lime
	"#9fb4ff", // periwinkle
];

export const ROOT_COLOR = "#dfe7ff";

export function assignFolderColors(nodes: GraphNode[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const n of nodes) {
		if (n.folder) counts.set(n.folder, (counts.get(n.folder) || 0) + 1);
	}
	const folders = [...counts.keys()].sort(
		(a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b),
	);
	const map = new Map<string, string>();
	map.set("", ROOT_COLOR);
	folders.forEach((f, i) => map.set(f, PALETTE[i % PALETTE.length]));
	return map;
}

export function hexToRgb(hex: string): [number, number, number] {
	let h = hex.replace("#", "");
	if (h.length === 3) h = h.split("").map((c) => c + c).join("");
	const n = parseInt(h, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(
	a: [number, number, number],
	b: [number, number, number],
	t: number,
): [number, number, number] {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

export function rgba(c: [number, number, number], a: number): string {
	return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
