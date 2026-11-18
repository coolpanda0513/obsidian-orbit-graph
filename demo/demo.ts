/**
 * Standalone demo: renders the orbit graph with a randomly generated vault.
 * Build with `npm run demo`, then open demo/index.html in a browser.
 */
import { buildGraph, NoteInfo } from "../src/graph";
import { OrbitRenderer } from "../src/renderer";
import { DEFAULT_SETTINGS } from "../src/types";

const params = new URLSearchParams(location.search);
const COUNT = Math.max(2, parseInt(params.get("n") || "260", 10));
const folders = ["Projects", "Areas", "Journal", "Reading", "Ideas", "People", "Recipes", ""];
const words = ["Nebula", "Quasar", "Orbit", "Pulsar", "Comet", "Lunar", "Solar", "Aurora", "Zenith", "Photon", "Eclipse", "Vortex", "Halo", "Ion", "Gravity", "Cosmos", "Meridian", "Drift", "Signal", "Horizon"];

let seed = parseInt(params.get("seed") || "3", 10);
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const notes: NoteInfo[] = [];
for (let i = 0; i < COUNT; i++) {
	const folder = folders[Math.floor(Math.pow(rand(), 1.4) * folders.length)];
	const name = `${words[Math.floor(rand() * words.length)]} ${words[Math.floor(rand() * words.length)].toLowerCase()} ${i}`;
	notes.push({ path: `${folder ? folder + "/" : ""}${name}.md`, name, folder });
}
// Preferential attachment so a few notes become hubs; ~12% are orphans.
const links: Record<string, Record<string, number>> = {};
const degree = new Array(COUNT).fill(1);
for (let i = 1; i < COUNT; i++) {
	if (rand() < 0.12) continue;
	const k = 1 + Math.floor(rand() * 2.5);
	for (let j = 0; j < k; j++) {
		let total = 0;
		for (let t = 0; t < i; t++) total += degree[t];
		let pick = rand() * total;
		let target = 0;
		for (; target < i - 1; target++) {
			pick -= degree[target];
			if (pick <= 0) break;
		}
		(links[notes[i].path] ||= {})[notes[target].path] = 1;
		degree[target]++;
		degree[i]++;
	}
}

const graph = buildGraph(notes, links);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const label = document.getElementById("hover")!;
const settings = { ...DEFAULT_SETTINGS };
const renderer = new OrbitRenderer(canvas, settings, {
	onHover: (id) => (label.textContent = id || ""),
	onClick: (id) => renderer.setCenter(id),
});
renderer.setGraph(graph);
(window as unknown as { orbit: unknown }).orbit = { renderer, graph, settings };
