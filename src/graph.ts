/**
 * Pure graph + orbital layout logic. No Obsidian imports so it can be unit-tested
 * and used by the standalone demo.
 */

export interface NoteInfo {
	/** Vault path, used as the unique id. */
	path: string;
	/** Display name (basename). */
	name: string;
	/** Top-level folder ("" for the vault root). Used for coloring. */
	folder: string;
}

export interface GraphNode extends NoteInfo {
	index: number;
	degree: number;
	neighbors: number[];
}

export interface GraphData {
	nodes: GraphNode[];
	/** Undirected, de-duplicated edges as [lowIndex, highIndex]. */
	edges: Array<[number, number]>;
	byId: Map<string, number>;
}

export interface OrbitLayout {
	center: number;
	/** Orbit number per node: 0 = center, 1..n = orbit, -1 = outer belt (unreachable). */
	ringOf: Int32Array;
	/** rings[k] = node indices on orbit k, in angular order. rings[0] = [center]. */
	rings: number[][];
	/** Unreachable notes, in angular order. */
	belt: number[];
}

/** Build an undirected graph from Obsidian-style resolved links. */
export function buildGraph(
	notes: NoteInfo[],
	links: Record<string, Record<string, number>>,
): GraphData {
	const nodes: GraphNode[] = notes.map((n, i) => ({
		...n,
		index: i,
		degree: 0,
		neighbors: [],
	}));
	const byId = new Map<string, number>();
	for (const n of nodes) byId.set(n.path, n.index);

	const edges: Array<[number, number]> = [];
	const seen = new Set<number>();
	const N = nodes.length;
	for (const src in links) {
		const a = byId.get(src);
		if (a === undefined) continue;
		const targets = links[src];
		for (const dst in targets) {
			const b = byId.get(dst);
			if (b === undefined || b === a) continue;
			const lo = a < b ? a : b;
			const hi = a < b ? b : a;
			const key = lo * N + hi;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push([lo, hi]);
			nodes[lo].neighbors.push(hi);
			nodes[hi].neighbors.push(lo);
		}
	}
	for (const n of nodes) n.degree = n.neighbors.length;
	return { nodes, edges, byId };
}

/** The most-connected note (ties broken alphabetically). */
export function findHub(graph: GraphData): string | null {
	let best: GraphNode | null = null;
	for (const n of graph.nodes) {
		if (
			!best ||
			n.degree > best.degree ||
			(n.degree === best.degree && n.name.localeCompare(best.name) < 0)
		) {
			best = n;
		}
	}
	return best ? best.path : null;
}

/** Deterministic 0..1 hash of a string (FNV-1a). */
export function hash01(s: string, seed = 0): number {
	let h = 0x811c9dc5 ^ seed;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return ((h >>> 0) % 100000) / 100000;
}

/**
 * Place notes on concentric orbits by link distance from the center note (BFS).
 * Within an orbit, notes are ordered next to the note that "discovered" them so
 * that links mostly fan outward instead of criss-crossing the system.
 */
export function computeLayout(
	graph: GraphData,
	center: number,
	maxOrbits: number,
): OrbitLayout {
	const N = graph.nodes.length;
	const ringOf = new Int32Array(N).fill(-1);
	const anchor = new Int32Array(N).fill(-1);
	const rings: number[][] = [[center]];
	const belt: number[] = [];
	if (N === 0 || center < 0 || center >= N) {
		return { center, ringOf, rings: [], belt };
	}
	maxOrbits = Math.max(1, Math.floor(maxOrbits));

	const depth = new Int32Array(N).fill(-1);
	depth[center] = 0;
	ringOf[center] = 0;
	const queue: number[] = [center];
	for (let qi = 0; qi < queue.length; qi++) {
		const u = queue[qi];
		for (const v of graph.nodes[u].neighbors) {
			if (depth[v] !== -1) continue;
			depth[v] = depth[u] + 1;
			const ring = Math.min(depth[v], maxOrbits);
			ringOf[v] = ring;
			// Anchor = ancestor that lives on the previous orbit.
			anchor[v] = depth[v] <= maxOrbits ? u : anchor[u];
			(rings[ring] ||= []).push(v);
			queue.push(v);
		}
	}

	// Angular slot fraction (0..1) of each placed node, filled ring by ring.
	const slot = new Float64Array(N);
	const nodes = graph.nodes;
	for (let k = 1; k < rings.length; k++) {
		const ring = rings[k] || (rings[k] = []);
		if (k === 1) {
			ring.sort(
				(a, b) =>
					nodes[a].folder.localeCompare(nodes[b].folder) ||
					nodes[a].name.localeCompare(nodes[b].name),
			);
		} else {
			ring.sort(
				(a, b) =>
					slot[anchor[a]] - slot[anchor[b]] ||
					nodes[a].folder.localeCompare(nodes[b].folder) ||
					nodes[a].name.localeCompare(nodes[b].name),
			);
		}
		for (let i = 0; i < ring.length; i++) slot[ring[i]] = i / ring.length;
	}

	for (let i = 0; i < N; i++) if (ringOf[i] === -1) belt.push(i);
	belt.sort((a, b) => hash01(nodes[a].path) - hash01(nodes[b].path));

	return { center, ringOf, rings, belt };
}
