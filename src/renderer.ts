import { computeLayout, findHub, GraphData, hash01, OrbitLayout } from "./graph";
import { hexToRgb, mix, rgba, ROOT_COLOR } from "./palette";
import type { OrbitSettings } from "./types";

/**
 * Canvas 2D renderer for the orbit graph. Independent of Obsidian: it takes a
 * graph + settings and reports interactions through callbacks.
 *
 * World model: every note is a body moving on a circular orbit in a flat plane
 * around the center note (the sun). The plane is tilted towards the viewer and
 * drawn with a mild perspective so near planets look bigger than far ones.
 */

export interface RendererCallbacks {
	onHover?(id: string | null, x: number, y: number, ev: MouseEvent | null): void;
	onClick?(id: string, ev: MouseEvent): void;
	onContextMenu?(id: string, ev: MouseEvent): void;
	onLayout?(): void;
}

export interface RendererOptions {
	fontFamily?: string;
}

type RGB = [number, number, number];

interface ColorInfo {
	hex: string;
	rgb: RGB;
	light: string;
	dark: string;
	sprite: HTMLCanvasElement;
}

interface Body {
	id: string;
	idx: number;
	name: string;
	/** Current / target orbital radius (world units). */
	r: number;
	targetR: number;
	/** Current angle; eases towards ringAngle + slot. */
	angle: number;
	slot: number;
	/** 0 = sun, 1..n = orbit, -1 = belt. */
	ring: number;
	hidden: boolean;
	size: number;
	degree: number;
	color: ColorInfo;
	alpha: number;
	// Projected (screen) values, refreshed every frame.
	sx: number;
	sy: number;
	sz: number;
	ss: number;
	rad: number;
}

interface Star {
	x: number;
	y: number;
	r: number;
	layer: number;
	phase: number;
	speed: number;
	bright: number;
	color: string;
}

interface ShootingStar {
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	max: number;
}

interface Signal {
	edge: number;
	t: number;
	speed: number;
	reverse: boolean;
}

interface EdgeBucket {
	color: ColorInfo;
	/** Flat list of node index pairs. */
	pairs: number[];
}

const TAU = Math.PI * 2;
const FIRST_ORBIT = 170;
const ORBIT_GAP = 105;
const SLOT_SPACING = 30;
const LANE_SPACING = 18;
const SUN_SIZE = 30;
const DEEP_SPACE: RGB = [4, 6, 20];

function angleDiff(target: number, current: number): number {
	let d = (target - current) % TAU;
	if (d > Math.PI) d -= TAU;
	if (d < -Math.PI) d += TAU;
	return d;
}

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/** Small deterministic PRNG so the starfield doesn't jump on every resize. */
function mulberry32(seed: number): () => number {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = Math.max(1, Math.round(w));
	c.height = Math.max(1, Math.round(h));
	return c;
}

function glowSprite(rgb: RGB): HTMLCanvasElement {
	const S = 64;
	const c = makeCanvas(S, S);
	const g = c.getContext("2d")!;
	const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
	grad.addColorStop(0, "rgba(255,255,255,0.95)");
	grad.addColorStop(0.1, rgba(rgb, 0.85));
	grad.addColorStop(0.28, rgba(rgb, 0.32));
	grad.addColorStop(0.6, rgba(rgb, 0.07));
	grad.addColorStop(1, rgba(rgb, 0));
	g.fillStyle = grad;
	g.fillRect(0, 0, S, S);
	return c;
}

function sunSprite(): HTMLCanvasElement {
	const S = 256;
	const c = makeCanvas(S, S);
	const g = c.getContext("2d")!;
	const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
	grad.addColorStop(0, "rgba(255,250,235,1)");
	grad.addColorStop(0.08, "rgba(255,226,160,0.9)");
	grad.addColorStop(0.2, "rgba(255,170,80,0.38)");
	grad.addColorStop(0.45, "rgba(255,110,70,0.1)");
	grad.addColorStop(0.7, "rgba(190,90,255,0.035)");
	grad.addColorStop(1, "rgba(120,80,255,0)");
	g.fillStyle = grad;
	g.fillRect(0, 0, S, S);
	return c;
}

export class OrbitRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private settings: OrbitSettings;
	private callbacks: RendererCallbacks;
	private fontFamily: string;

	private w = 0;
	private h = 0;
	private dpr = 1;

	private graph: GraphData | null = null;
	private layout: OrbitLayout | null = null;
	private centerId: string | null = null;
	private bodies: Body[] = [];
	private bodyById = new Map<string, Body>();
	private folderColors = new Map<string, string>();
	private colorCache = new Map<string, ColorInfo>();
	private edgeBuckets: EdgeBucket[] = [];

	private ringRadius: number[] = [];
	private ringLanes: number[] = [];
	private ringAngle: number[] = [];
	private beltR = 0;
	private beltW = 0;
	private beltAngle = 0;
	private outerR = 300;

	// Camera (current + target for smooth easing)
	private zoom = 1;
	private tZoom = 1;
	private panX = 0;
	private panY = 0;
	private tPanX = 0;
	private tPanY = 0;
	private tilt: number;
	private tTilt: number;
	private sunX = 0;
	private sunY = 0;

	// Interaction
	private hovered = -1;
	private hoverNeighbors = new Set<number>();
	private highlight: Set<string> | null = null;
	private drag: {
		startX: number;
		startY: number;
		startPanX: number;
		startPanY: number;
		startTilt: number;
		mode: "pan" | "tilt";
		moved: boolean;
		pointerId: number;
	} | null = null;
	private mouseX = -1;
	private mouseY = -1;

	// Ambience
	private nebula: HTMLCanvasElement | null = null;
	private stars: Star[] = [];
	private shooting: ShootingStar[] = [];
	private nextShoot = 3;
	private signals: Signal[] = [];
	private sun: HTMLCanvasElement;
	private starGlow: HTMLCanvasElement;

	private time = 0;
	private last = 0;
	private raf = 0;
	private destroyed = false;
	private firstLayout = true;
	private order: number[] = [];
	private resizeObserver: ResizeObserver | null = null;
	private cleanup: Array<() => void> = [];

	constructor(
		canvas: HTMLCanvasElement,
		settings: OrbitSettings,
		callbacks: RendererCallbacks = {},
		options: RendererOptions = {},
	) {
		this.canvas = canvas;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D is not available");
		this.ctx = ctx;
		this.settings = { ...settings };
		this.callbacks = callbacks;
		this.fontFamily = options.fontFamily || "system-ui, sans-serif";
		this.tilt = this.tTilt = (settings.tilt * Math.PI) / 180;
		this.sun = sunSprite();
		this.starGlow = glowSprite([210, 225, 255]);

		this.bindEvents();
		const parent = canvas.parentElement;
		if (parent && typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => this.resize());
			this.resizeObserver.observe(parent);
		}
		this.resize();
		this.raf = requestAnimationFrame(this.frame);
	}

	// ------------------------------------------------------------------ public API

	/**
	 * Replace the graph. Bodies are matched by id so existing planets glide to
	 * their new orbits instead of jumping. Pass `center` to also move the sun.
	 */
	setGraph(graph: GraphData, folderColors: Map<string, string>, center?: string | null): void {
		const refit = center !== undefined && center !== this.centerId;
		if (center !== undefined) this.centerId = center;
		this.graph = graph;
		this.folderColors = folderColors;
		const old = this.bodyById;
		const bodies: Body[] = [];
		const byId = new Map<string, Body>();
		for (const node of graph.nodes) {
			let b = old.get(node.path);
			if (!b) {
				b = {
					id: node.path,
					idx: node.index,
					name: node.name,
					r: -1,
					targetR: 0,
					angle: 0,
					slot: 0,
					ring: -1,
					hidden: false,
					size: 0,
					degree: 0,
					color: this.colorFor(ROOT_COLOR),
					alpha: 0,
					sx: 0,
					sy: 0,
					sz: 0,
					ss: 1,
					rad: 0,
				};
			}
			b.idx = node.index;
			b.name = node.name;
			b.degree = node.degree;
			b.size = Math.min(18, 4 + Math.sqrt(node.degree) * 2.1);
			b.color = this.colorFor(folderColors.get(node.folder) || ROOT_COLOR);
			bodies.push(b);
			byId.set(node.path, b);
		}
		this.bodies = bodies;
		this.bodyById = byId;
		if (this.hovered >= bodies.length) this.setHovered(-1, null);
		this.relayout(refit);
	}

	setCenter(id: string | null): void {
		if (id === this.centerId) return;
		this.centerId = id;
		this.relayout(true);
	}

	getCenterId(): string | null {
		const c = this.layout?.center;
		return c !== undefined && this.bodies[c] ? this.bodies[c].id : null;
	}

	/** Orbit number for a note: 0 = sun, -1 = outer belt, null = unknown/hidden. */
	getOrbit(id: string): number | null {
		const b = this.bodyById.get(id);
		if (!b || b.hidden) return null;
		return b.ring;
	}

	getOrbitCount(): number {
		return Math.max(0, this.ringRadius.length - 1);
	}

	setHighlight(ids: Set<string> | null): void {
		this.highlight = ids && ids.size ? ids : ids ? new Set() : null;
	}

	updateSettings(settings: OrbitSettings): void {
		const prev = this.settings;
		this.settings = { ...settings };
		this.tTilt = (settings.tilt * Math.PI) / 180;
		if (prev.maxOrbits !== settings.maxOrbits || prev.showOrphans !== settings.showOrphans) {
			this.relayout(true);
		}
		if (prev.starDensity !== settings.starDensity) this.generateStars();
		if (prev.showSignals !== settings.showSignals) this.resetSignals();
	}

	/** Zoom so the whole system fits on screen. */
	fit(immediate = false): void {
		if (!this.w || !this.h) return;
		const outer = Math.max(this.outerR, FIRST_ORBIT);
		const F = this.focal();
		const ct = Math.cos(this.tTilt);
		const st = Math.sin(this.tTilt);
		const sNear = F / (F - outer * st);
		const zx = (this.w * 0.46) / (outer * 1.05);
		const zy = (this.h * 0.44) / Math.max(outer * ct * sNear, outer * 0.25);
		const z = clamp(Math.min(zx, zy), 0.02, 4);
		this.tZoom = z;
		this.tPanX = 0;
		this.tPanY = 0;
		if (immediate) {
			this.zoom = z;
			this.panX = 0;
			this.panY = 0;
		}
	}

	destroy(): void {
		this.destroyed = true;
		cancelAnimationFrame(this.raf);
		this.resizeObserver?.disconnect();
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
	}

	// ------------------------------------------------------------------ layout

	private colorFor(hex: string): ColorInfo {
		let c = this.colorCache.get(hex);
		if (!c) {
			const rgb = hexToRgb(hex);
			c = {
				hex,
				rgb,
				light: rgba(mix(rgb, [255, 255, 255], 0.6), 1),
				dark: rgba(mix(rgb, DEEP_SPACE, 0.82), 1),
				sprite: glowSprite(rgb),
			};
			this.colorCache.set(hex, c);
		}
		return c;
	}

	private focal(): number {
		return Math.max(1800, this.outerR * 4);
	}

	private relayout(refit = false): void {
		const graph = this.graph;
		if (!graph || graph.nodes.length === 0) {
			this.layout = null;
			this.ringRadius = [];
			this.edgeBuckets = [];
			this.signals = [];
			this.callbacks.onLayout?.();
			return;
		}
		let center = this.centerId !== null ? graph.byId.get(this.centerId) : undefined;
		if (center === undefined) {
			const hub = findHub(graph);
			center = hub !== null ? graph.byId.get(hub) ?? 0 : 0;
		}
		const layout = computeLayout(graph, center, this.settings.maxOrbits);
		this.layout = layout;

		// Orbit radii: grow outward; crowded orbits split into several lanes.
		const radii = [0];
		const lanesArr = [1];
		let outer = 0;
		for (let k = 1; k < layout.rings.length; k++) {
			const n = layout.rings[k].length;
			const base = k === 1 ? FIRST_ORBIT : outer + ORBIT_GAP;
			const r = Math.max(base, Math.min((n * SLOT_SPACING) / TAU, base * 1.5));
			const capacity = Math.max(1, Math.floor((TAU * r) / SLOT_SPACING));
			const lanes = Math.max(1, Math.ceil(n / capacity));
			radii.push(r);
			lanesArr.push(lanes);
			outer = r + (lanes - 1) * LANE_SPACING;
		}
		this.ringRadius = radii;
		this.ringLanes = lanesArr;
		while (this.ringAngle.length < radii.length) this.ringAngle.push(Math.random() * TAU);

		for (let k = 0; k < layout.rings.length; k++) {
			const ring = layout.rings[k];
			const n = ring.length;
			const lanes = lanesArr[k];
			for (let i = 0; i < n; i++) {
				const b = this.bodies[ring[i]];
				b.ring = k;
				b.hidden = false;
				b.slot = n ? (TAU * i) / n : 0;
				const lane = lanes > 1 ? i % lanes : 0;
				const jitter = k === 0 ? 0 : (hash01(b.id, 7) - 0.5) * 6;
				b.targetR = radii[k] + lane * LANE_SPACING + jitter;
			}
		}

		const belt = layout.belt;
		if (belt.length && this.settings.showOrphans) {
			this.beltR = (outer || FIRST_ORBIT) + ORBIT_GAP * 1.15;
			this.beltW = Math.max(50, (belt.length * SLOT_SPACING * LANE_SPACING) / (TAU * this.beltR));
			for (let i = 0; i < belt.length; i++) {
				const b = this.bodies[belt[i]];
				b.ring = -1;
				b.hidden = false;
				b.slot = (TAU * i) / belt.length;
				b.targetR = this.beltR + hash01(b.id, 13) * this.beltW;
			}
			this.outerR = this.beltR + this.beltW;
		} else {
			this.beltR = 0;
			this.beltW = 0;
			for (const i of belt) {
				const b = this.bodies[i];
				b.ring = -1;
				b.hidden = true;
				b.targetR = (outer || FIRST_ORBIT) * 1.6;
			}
			this.outerR = Math.max(outer, FIRST_ORBIT);
		}

		// New bodies: spiral out of the sun on first load, otherwise drift in.
		for (const b of this.bodies) {
			if (b.r >= 0) continue;
			if (this.firstLayout) {
				b.r = b.targetR * 0.05;
				b.angle = this.targetAngle(b) - 2.2 - hash01(b.id, 3);
			} else {
				b.r = b.targetR + 160;
				b.angle = this.targetAngle(b);
			}
			b.alpha = 0;
		}

		// Links are colored by their inner endpoint so they "radiate" outward.
		const buckets = new Map<string, EdgeBucket>();
		for (const [a, c] of graph.edges) {
			const ba = this.bodies[a];
			const bc = this.bodies[c];
			const ra = ba.ring < 0 ? 1e9 : ba.ring;
			const rc = bc.ring < 0 ? 1e9 : bc.ring;
			const inner = ra <= rc ? ba : bc;
			let bucket = buckets.get(inner.color.hex);
			if (!bucket) {
				bucket = { color: inner.color, pairs: [] };
				buckets.set(inner.color.hex, bucket);
			}
			bucket.pairs.push(a, c);
		}
		this.edgeBuckets = [...buckets.values()];
		this.resetSignals();

		if (this.firstLayout && this.w) {
			this.firstLayout = false;
			this.fit(true);
			// Start zoomed in and pull back for a cinematic intro.
			this.zoom = this.tZoom * 2.4;
		} else if (refit && !this.firstLayout) {
			this.fit();
		}
		this.callbacks.onLayout?.();
	}

	private targetAngle(b: Body): number {
		if (b.ring > 0) return (this.ringAngle[b.ring] || 0) + b.slot;
		if (b.ring === -1) return this.beltAngle + b.slot;
		return 0;
	}

	private omega(r: number): number {
		// Kepler-ish: inner orbits move faster.
		return 0.09 * Math.pow(200 / Math.max(r, 60), 1.5);
	}

	private resetSignals(): void {
		this.signals = [];
		const edges = this.graph?.edges.length || 0;
		if (!this.settings.showSignals || !edges) return;
		const n = Math.min(40, Math.ceil(edges / 3));
		for (let i = 0; i < n; i++) {
			const s: Signal = { edge: 0, t: 0, speed: 0, reverse: false };
			this.spawnSignal(s);
			s.t = Math.random();
			this.signals.push(s);
		}
	}

	private spawnSignal(s: Signal): void {
		const graph = this.graph;
		if (!graph || !graph.edges.length) return;
		s.edge = Math.floor(Math.random() * graph.edges.length);
		if (this.hovered >= 0 && Math.random() < 0.75) {
			const nb = graph.nodes[this.hovered]?.neighbors;
			if (nb && nb.length) {
				const other = nb[Math.floor(Math.random() * nb.length)];
				const lo = Math.min(other, this.hovered);
				const hi = Math.max(other, this.hovered);
				const idx = graph.edges.findIndex((e) => e[0] === lo && e[1] === hi);
				if (idx >= 0) s.edge = idx;
			}
		}
		s.t = 0;
		s.speed = 0.25 + Math.random() * 0.45;
		const [a, b] = graph.edges[s.edge];
		// Mostly travel outward from the sun.
		const ra = this.bodies[a]?.ring ?? 0;
		const rb = this.bodies[b]?.ring ?? 0;
		const outward = (ra < 0 ? 99 : ra) <= (rb < 0 ? 99 : rb);
		s.reverse = Math.random() < 0.8 ? !outward : outward;
	}

	// ------------------------------------------------------------------ sizing & ambience

	private resize(): void {
		const parent = this.canvas.parentElement;
		const w = parent ? parent.clientWidth : this.canvas.clientWidth;
		const h = parent ? parent.clientHeight : this.canvas.clientHeight;
		if (!w || !h) {
			this.w = this.h = 0;
			return;
		}
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		if (w === this.w && h === this.h && dpr === this.dpr) return;
		this.w = w;
		this.h = h;
		this.dpr = dpr;
		this.canvas.width = Math.round(w * dpr);
		this.canvas.height = Math.round(h * dpr);
		this.generateNebula();
		this.generateStars();
		if (this.firstLayout && this.layout) {
			this.firstLayout = false;
			this.fit(true);
			this.zoom = this.tZoom * 2.4;
		}
	}

	private generateNebula(): void {
		const { w, h } = this;
		const c = makeCanvas(w, h);
		const g = c.getContext("2d")!;
		const base = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
		base.addColorStop(0, "#0c1030");
		base.addColorStop(0.55, "#060820");
		base.addColorStop(1, "#020309");
		g.fillStyle = base;
		g.fillRect(0, 0, w, h);

		const rand = mulberry32(1337);
		const hues = [265, 222, 190, 305, 245, 175, 330];
		g.globalCompositeOperation = "lighter";
		for (let i = 0; i < hues.length; i++) {
			const x = rand() * w;
			const y = rand() * h;
			const r = (0.25 + rand() * 0.45) * Math.max(w, h);
			const hue = hues[i];
			const grad = g.createRadialGradient(x, y, 0, x, y, r);
			grad.addColorStop(0, `hsla(${hue},85%,58%,0.11)`);
			grad.addColorStop(0.45, `hsla(${hue},80%,45%,0.045)`);
			grad.addColorStop(1, `hsla(${hue},80%,40%,0)`);
			g.fillStyle = grad;
			g.fillRect(0, 0, w, h);
		}
		// Dusty wisps
		for (let i = 0; i < 26; i++) {
			const x = rand() * w;
			const y = rand() * h;
			const r = (0.04 + rand() * 0.12) * Math.max(w, h);
			const hue = hues[Math.floor(rand() * hues.length)];
			const grad = g.createRadialGradient(x, y, 0, x, y, r);
			grad.addColorStop(0, `hsla(${hue},90%,70%,0.035)`);
			grad.addColorStop(1, `hsla(${hue},90%,50%,0)`);
			g.fillStyle = grad;
			g.fillRect(0, 0, w, h);
		}
		g.globalCompositeOperation = "source-over";
		const vig = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.8);
		vig.addColorStop(0, "rgba(0,0,0,0)");
		vig.addColorStop(1, "rgba(0,0,5,0.6)");
		g.fillStyle = vig;
		g.fillRect(0, 0, w, h);
		this.nebula = c;
	}

	private generateStars(): void {
		const rand = mulberry32(42);
		const count = Math.round(((this.w * this.h) / 1900) * this.settings.starDensity);
		const tints = ["#ffffff", "#ffffff", "#dfe8ff", "#cfe0ff", "#fff1d6", "#e6d9ff"];
		this.stars = [];
		for (let i = 0; i < count; i++) {
			const big = rand();
			this.stars.push({
				x: rand() * this.w,
				y: rand() * this.h,
				r: 0.4 + Math.pow(big, 4) * 1.6,
				layer: 0.01 + rand() * 0.09,
				phase: rand() * TAU,
				speed: 0.4 + rand() * 2.2,
				bright: 0.35 + rand() * 0.65,
				color: tints[Math.floor(rand() * tints.length)],
			});
		}
	}

	// ------------------------------------------------------------------ events

	private bindEvents(): void {
		const c = this.canvas;
		const on = <K extends keyof HTMLElementEventMap>(
			type: K,
			fn: (ev: HTMLElementEventMap[K]) => void,
			opts?: AddEventListenerOptions,
		) => {
			c.addEventListener(type, fn as EventListener, opts);
			this.cleanup.push(() => c.removeEventListener(type, fn as EventListener, opts));
		};

		on("pointerdown", (e) => {
			if (e.button !== 0 && e.button !== 1) return;
			const p = this.local(e);
			this.drag = {
				startX: p.x,
				startY: p.y,
				startPanX: this.tPanX,
				startPanY: this.tPanY,
				startTilt: this.tTilt,
				mode: e.shiftKey || e.button === 1 ? "tilt" : "pan",
				moved: false,
				pointerId: e.pointerId,
			};
			try {
				c.setPointerCapture(e.pointerId);
			} catch (_) {
				/* ignore */
			}
		});

		on("pointermove", (e) => {
			const p = this.local(e);
			this.mouseX = p.x;
			this.mouseY = p.y;
			const d = this.drag;
			if (d) {
				const dx = p.x - d.startX;
				const dy = p.y - d.startY;
				if (!d.moved && dx * dx + dy * dy > 16) {
					d.moved = true;
					c.classList.add("is-dragging");
					this.setHovered(-1, e);
				}
				if (d.moved) {
					if (d.mode === "pan") {
						this.tPanX = this.panX = d.startPanX + dx;
						this.tPanY = this.panY = d.startPanY + dy;
					} else {
						this.tTilt = this.tilt = clamp(d.startTilt - dy * 0.006, 0, 1.4);
					}
				}
				return;
			}
			this.setHovered(this.hitTest(p.x, p.y), e);
		});

		const endDrag = (e: PointerEvent) => {
			const d = this.drag;
			if (!d || d.pointerId !== e.pointerId) return;
			this.drag = null;
			c.classList.remove("is-dragging");
			try {
				c.releasePointerCapture(e.pointerId);
			} catch (_) {
				/* ignore */
			}
			if (!d.moved && e.type === "pointerup" && e.button === 0) {
				const p = this.local(e);
				const hit = this.hitTest(p.x, p.y);
				if (hit >= 0) this.callbacks.onClick?.(this.bodies[hit].id, e);
			}
		};
		on("pointerup", endDrag);
		on("pointercancel", endDrag);

		on("pointerleave", (e) => {
			this.mouseX = this.mouseY = -1;
			if (!this.drag) this.setHovered(-1, e);
		});

		on("contextmenu", (e) => {
			e.preventDefault();
			const p = this.local(e);
			const hit = this.hitTest(p.x, p.y);
			if (hit >= 0) this.callbacks.onContextMenu?.(this.bodies[hit].id, e);
		});

		on(
			"wheel",
			(e) => {
				e.preventDefault();
				const p = this.local(e);
				const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
				const factor = Math.exp(-delta * 0.0015);
				const z = clamp(this.tZoom * factor, 0.02, 8);
				const mx = p.x - this.w / 2;
				const my = p.y - this.h / 2;
				this.tPanX = mx - (mx - this.tPanX) * (z / this.tZoom);
				this.tPanY = my - (my - this.tPanY) * (z / this.tZoom);
				this.tZoom = z;
			},
			{ passive: false },
		);

		on("dblclick", (e) => {
			const p = this.local(e);
			if (this.hitTest(p.x, p.y) < 0) this.fit();
		});
	}

	private local(e: MouseEvent): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private setHovered(idx: number, ev: MouseEvent | null): void {
		if (idx === this.hovered) return;
		this.hovered = idx;
		this.hoverNeighbors = new Set(idx >= 0 ? this.graph?.nodes[idx]?.neighbors || [] : []);
		this.canvas.classList.toggle("is-hovering", idx >= 0);
		const b = idx >= 0 ? this.bodies[idx] : null;
		this.callbacks.onHover?.(b ? b.id : null, b ? b.sx : 0, b ? b.sy : 0, ev);
	}

	private hitTest(x: number, y: number): number {
		if (!this.layout) return -1;
		let best = -1;
		let bestZ = -Infinity;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (b.hidden || b.alpha < 0.05) continue;
			const r = Math.max(b.rad, 5) + 3;
			const dx = b.sx - x;
			const dy = b.sy - y;
			if (dx * dx + dy * dy <= r * r && b.sz > bestZ) {
				best = i;
				bestZ = b.sz;
			}
		}
		return best;
	}

	// ------------------------------------------------------------------ frame loop

	private frame = (t: number): void => {
		if (this.destroyed) return;
		this.raf = requestAnimationFrame(this.frame);
		const dt = this.last ? clamp((t - this.last) / 1000, 0, 0.05) : 0.016;
		this.last = t;
		if (!this.w || !this.h) {
			this.resize();
			return;
		}
		this.update(dt);
		this.draw();
	};

	private update(dt: number): void {
		this.time += dt;
		const speed = this.settings.orbitSpeed;
		for (let k = 1; k < this.ringRadius.length; k++) {
			this.ringAngle[k] += this.omega(this.ringRadius[k]) * dt * speed;
		}
		this.beltAngle += this.omega(this.beltR || 600) * dt * speed * 0.8;

		const ease = 1 - Math.exp(-dt * 2.2);
		const fade = 1 - Math.exp(-dt * 6);
		const hovering = this.hovered >= 0;
		const hl = this.highlight;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			b.r += (b.targetR - b.r) * ease;
			b.angle += angleDiff(this.targetAngle(b), b.angle) * ease;
			let ta = b.hidden ? 0 : b.ring === -1 ? 0.7 : 1;
			if (!b.hidden) {
				if (hovering) ta = i === this.hovered || this.hoverNeighbors.has(i) ? 1 : 0.16;
				else if (hl) ta = hl.has(b.id) ? 1 : 0.12;
			}
			b.alpha += (ta - b.alpha) * fade;
		}

		const cam = 1 - Math.exp(-dt * 7);
		this.zoom += (this.tZoom - this.zoom) * cam;
		this.panX += (this.tPanX - this.panX) * cam;
		this.panY += (this.tPanY - this.panY) * cam;
		this.tilt += (this.tTilt - this.tilt) * cam;

		for (const s of this.signals) {
			s.t += dt * s.speed;
			if (s.t >= 1) this.spawnSignal(s);
		}

		if (this.settings.starDensity > 0 && this.time > this.nextShoot) {
			this.nextShoot = this.time + 5 + Math.random() * 12;
			const ang = Math.PI * (0.15 + Math.random() * 0.25) * (Math.random() < 0.5 ? 1 : -1) + Math.PI / 2;
			const sp = 500 + Math.random() * 500;
			this.shooting.push({
				x: Math.random() * this.w,
				y: Math.random() * this.h * 0.5,
				vx: Math.cos(ang) * sp * (Math.random() < 0.5 ? 1 : -1),
				vy: Math.abs(Math.sin(ang)) * sp * 0.6,
				life: 0,
				max: 0.7 + Math.random() * 0.6,
			});
		}
		for (const s of this.shooting) {
			s.life += dt;
			s.x += s.vx * dt;
			s.y += s.vy * dt;
		}
		this.shooting = this.shooting.filter((s) => s.life < s.max);
	}

	private draw(): void {
		const ctx = this.ctx;
		const { w, h } = this;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
		this.drawBackground();

		const layout = this.layout;
		if (!layout) return;

		// --- project every body
		const cx = w / 2 + this.panX;
		const cy = h / 2 + this.panY;
		const ct = Math.cos(this.tilt);
		const st = Math.sin(this.tilt);
		const F = this.focal();
		const zoom = this.zoom;
		for (const b of this.bodies) {
			const px = b.r * Math.cos(b.angle);
			const pz = b.r * Math.sin(b.angle);
			const zt = pz * st;
			const s = F / (F - zt);
			b.sx = cx + px * s * zoom;
			b.sy = cy + pz * ct * s * zoom;
			b.sz = zt;
			b.ss = s;
			const size = b.ring === 0 ? SUN_SIZE : b.ring === -1 ? b.size * 0.72 : b.size;
			b.rad = Math.max(1.1, size * s * zoom);
		}
		const sunBody = this.bodies[layout.center];
		this.sunX = sunBody ? sunBody.sx : cx;
		this.sunY = sunBody ? sunBody.sy : cy;

		if (this.settings.showOrbits) this.drawOrbits(cx, cy, ct, st, F);
		if (this.settings.showLinks) this.drawLinks();
		if (this.settings.showSignals && this.settings.showLinks) this.drawSignals();

		// --- bodies, far to near
		const order = this.order;
		order.length = 0;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (!b.hidden || b.alpha > 0.01) order.push(i);
		}
		order.sort((a, b) => this.bodies[a].sz - this.bodies[b].sz);
		for (const i of order) {
			if (i === layout.center) this.drawSun(this.bodies[i]);
			else this.drawPlanet(this.bodies[i], i === this.hovered);
		}

		this.drawLabels();
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private drawBackground(): void {
		const ctx = this.ctx;
		const { w, h } = this;
		if (this.nebula) {
			ctx.drawImage(this.nebula, 0, 0, w, h);
		} else {
			ctx.fillStyle = "#03040b";
			ctx.fillRect(0, 0, w, h);
		}
		ctx.globalCompositeOperation = "lighter";
		const t = this.time;
		for (const s of this.stars) {
			let x = (s.x + this.panX * s.layer) % w;
			let y = (s.y + this.panY * s.layer) % h;
			if (x < 0) x += w;
			if (y < 0) y += h;
			const tw = 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
			ctx.globalAlpha = s.bright * tw;
			if (s.r > 1.3) {
				const g = s.r * 5;
				ctx.drawImage(this.starGlow, x - g, y - g, g * 2, g * 2);
			} else {
				ctx.fillStyle = s.color;
				ctx.fillRect(x - s.r / 2, y - s.r / 2, s.r, s.r);
			}
		}
		for (const s of this.shooting) {
			const k = s.life / s.max;
			const a = Math.sin(Math.PI * k);
			const tx = s.x - s.vx * 0.16;
			const ty = s.y - s.vy * 0.16;
			const grad = ctx.createLinearGradient(s.x, s.y, tx, ty);
			grad.addColorStop(0, `rgba(255,255,255,${0.9 * a})`);
			grad.addColorStop(0.3, `rgba(170,200,255,${0.4 * a})`);
			grad.addColorStop(1, "rgba(120,140,255,0)");
			ctx.globalAlpha = 1;
			ctx.strokeStyle = grad;
			ctx.lineWidth = 1.4;
			ctx.beginPath();
			ctx.moveTo(s.x, s.y);
			ctx.lineTo(tx, ty);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private orbitPath(r: number, cx: number, cy: number, ct: number, st: number, F: number): void {
		const ctx = this.ctx;
		const zoom = this.zoom;
		const steps = 180;
		ctx.beginPath();
		for (let i = 0; i <= steps; i++) {
			const a = (i / steps) * TAU;
			const px = r * Math.cos(a);
			const pz = r * Math.sin(a);
			const s = F / (F - pz * st);
			const x = cx + px * s * zoom;
			const y = cy + pz * ct * s * zoom;
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
	}

	private drawOrbits(cx: number, cy: number, ct: number, st: number, F: number): void {
		const ctx = this.ctx;
		const glow = this.settings.glowIntensity;
		const dim = this.hovered >= 0 || this.highlight ? 0.5 : 1;
		ctx.globalCompositeOperation = "lighter";
		for (let k = 1; k < this.ringRadius.length; k++) {
			const lanes = this.ringLanes[k];
			const band = (lanes - 1) * LANE_SPACING;
			const r = this.ringRadius[k] + band / 2;
			this.orbitPath(r, cx, cy, ct, st, F);
			if (lanes > 1) {
				ctx.strokeStyle = `rgba(110,140,255,${0.045 * glow * dim})`;
				ctx.lineWidth = Math.max(2, (band + 14) * this.zoom);
				ctx.stroke();
			}
			ctx.strokeStyle = `rgba(120,160,255,${0.06 * glow * dim})`;
			ctx.lineWidth = 4;
			ctx.stroke();
			ctx.strokeStyle = `rgba(175,205,255,${0.2 * dim})`;
			ctx.lineWidth = 1;
			ctx.stroke();
		}
		if (this.beltW > 0) {
			this.orbitPath(this.beltR + this.beltW / 2, cx, cy, ct, st, F);
			ctx.strokeStyle = `rgba(160,130,255,${0.04 * glow * dim})`;
			ctx.lineWidth = Math.max(2, this.beltW * this.zoom);
			ctx.stroke();
		}
		ctx.globalCompositeOperation = "source-over";
	}

	private controlPoint(a: Body, b: Body): [number, number] {
		const mx = (a.sx + b.sx) / 2;
		const my = (a.sy + b.sy) / 2;
		return [mx + (this.sunX - mx) * 0.1, my + (this.sunY - my) * 0.1];
	}

	private drawLinks(): void {
		const ctx = this.ctx;
		const bodies = this.bodies;
		const focus = this.hovered >= 0 || this.highlight !== null;
		const base = this.settings.linkOpacity * (focus ? 0.25 : 1);
		ctx.globalCompositeOperation = "lighter";
		ctx.lineWidth = 1;
		if (base > 0.001) {
			for (const bucket of this.edgeBuckets) {
				ctx.strokeStyle = rgba(bucket.color.rgb, 0.22 * base);
				ctx.beginPath();
				const p = bucket.pairs;
				for (let i = 0; i < p.length; i += 2) {
					const a = bodies[p[i]];
					const b = bodies[p[i + 1]];
					if (a.hidden || b.hidden) continue;
					const [qx, qy] = this.controlPoint(a, b);
					ctx.moveTo(a.sx, a.sy);
					ctx.quadraticCurveTo(qx, qy, b.sx, b.sy);
				}
				ctx.stroke();
			}
		}

		// Hovered note: bright, animated links to its neighbors.
		if (this.hovered >= 0 && this.graph) {
			const hb = bodies[this.hovered];
			ctx.beginPath();
			for (const n of this.hoverNeighbors) {
				const b = bodies[n];
				if (b.hidden) continue;
				const [qx, qy] = this.controlPoint(hb, b);
				ctx.moveTo(hb.sx, hb.sy);
				ctx.quadraticCurveTo(qx, qy, b.sx, b.sy);
			}
			ctx.strokeStyle = rgba(hb.color.rgb, 0.35);
			ctx.lineWidth = 4;
			ctx.stroke();
			ctx.strokeStyle = rgba(hb.color.rgb, 0.9);
			ctx.lineWidth = 1.5;
			ctx.stroke();
			ctx.setLineDash([3, 9]);
			ctx.lineDashOffset = -this.time * 40;
			ctx.strokeStyle = "rgba(255,255,255,0.8)";
			ctx.lineWidth = 1.5;
			ctx.stroke();
			ctx.setLineDash([]);
		}
		ctx.globalCompositeOperation = "source-over";
	}

	private drawSignals(): void {
		const ctx = this.ctx;
		const graph = this.graph;
		if (!graph) return;
		ctx.globalCompositeOperation = "lighter";
		for (const s of this.signals) {
			const e = graph.edges[s.edge];
			if (!e) continue;
			let a = this.bodies[e[0]];
			let b = this.bodies[e[1]];
			if (!a || !b || a.hidden || b.hidden) continue;
			if (s.reverse) [a, b] = [b, a];
			const [qx, qy] = this.controlPoint(a, b);
			const t = s.t;
			const u = 1 - t;
			const x = u * u * a.sx + 2 * u * t * qx + t * t * b.sx;
			const y = u * u * a.sy + 2 * u * t * qy + t * t * b.sy;
			const vis = Math.min(a.alpha, b.alpha);
			ctx.globalAlpha = Math.sin(Math.PI * t) * 0.9 * vis;
			const g = 7 + 3 * this.settings.glowIntensity;
			ctx.drawImage(a.color.sprite, x - g, y - g, g * 2, g * 2);
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private drawPlanet(b: Body, hovered: boolean): void {
		const ctx = this.ctx;
		const rad = b.rad;
		const alpha = b.alpha * (0.78 + 0.22 * clamp(b.ss, 0, 1.3));
		if (alpha < 0.01) return;
		const glow = this.settings.glowIntensity;

		// Halo
		if (glow > 0) {
			ctx.globalCompositeOperation = "lighter";
			ctx.globalAlpha = alpha * 0.6 * glow * (hovered ? 1.6 : 1);
			const g = rad * (hovered ? 4.6 : 3.4) + 4;
			ctx.drawImage(b.color.sprite, b.sx - g, b.sy - g, g * 2, g * 2);
		}

		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = alpha;
		const ringed = b.degree >= 8 && rad > 3.5;
		const tiltY = 0.25 + 0.35 * Math.cos(this.tilt);
		if (ringed) this.drawPlanetRing(b, tiltY, true);

		if (rad > 3) {
			// Lit from the direction of the sun.
			let dx = this.sunX - b.sx;
			let dy = this.sunY - b.sy;
			const d = Math.hypot(dx, dy) || 1;
			dx /= d;
			dy /= d;
			const hx = b.sx + dx * rad * 0.45;
			const hy = b.sy + dy * rad * 0.45;
			const grad = ctx.createRadialGradient(hx, hy, rad * 0.05, b.sx, b.sy, rad);
			grad.addColorStop(0, b.color.light);
			grad.addColorStop(0.5, b.color.hex);
			grad.addColorStop(1, b.color.dark);
			ctx.fillStyle = grad;
		} else {
			ctx.fillStyle = b.color.light;
		}
		ctx.beginPath();
		ctx.arc(b.sx, b.sy, rad, 0, TAU);
		ctx.fill();

		if (ringed) this.drawPlanetRing(b, tiltY, false);

		if (hovered) {
			ctx.globalCompositeOperation = "lighter";
			ctx.globalAlpha = 0.65 + 0.25 * Math.sin(this.time * 5);
			ctx.strokeStyle = b.color.light;
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.arc(b.sx, b.sy, rad + 4 + Math.sin(this.time * 3) * 1.2, 0, TAU);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	/** Saturn-style ring for well-connected notes, drawn in two halves around the planet. */
	private drawPlanetRing(b: Body, tiltY: number, back: boolean): void {
		const ctx = this.ctx;
		const rx = b.rad * 2.1;
		const ry = rx * tiltY;
		const rot = -0.35;
		ctx.save();
		ctx.globalCompositeOperation = "lighter";
		ctx.strokeStyle = rgba(b.color.rgb, back ? 0.35 : 0.75);
		ctx.lineWidth = Math.max(1, b.rad * 0.22);
		ctx.beginPath();
		if (back) ctx.ellipse(b.sx, b.sy, rx, ry, rot, Math.PI, TAU);
		else ctx.ellipse(b.sx, b.sy, rx, ry, rot, 0, Math.PI);
		ctx.stroke();
		ctx.restore();
	}

	private drawSun(b: Body): void {
		const ctx = this.ctx;
		const pulse = 1 + 0.035 * Math.sin(this.time * 1.8) + 0.015 * Math.sin(this.time * 5.3);
		const R = b.rad * pulse;
		const glow = this.settings.glowIntensity;
		const x = b.sx;
		const y = b.sy;
		const a = Math.max(b.alpha, 0.35);

		ctx.globalCompositeOperation = "lighter";
		// Wide halo + corona
		ctx.globalAlpha = 0.55 * glow * a;
		let g = R * 11;
		ctx.drawImage(this.sun, x - g, y - g, g * 2, g * 2);
		ctx.globalAlpha = 0.9 * a;
		g = R * 4;
		ctx.drawImage(this.sun, x - g, y - g, g * 2, g * 2);

		// Lens-flare spikes, slowly turning
		if (glow > 0) {
			ctx.save();
			ctx.translate(x, y);
			ctx.rotate(this.time * 0.04);
			const spikes: Array<[number, number, number]> = [
				[0, R * 9, 0.5],
				[Math.PI / 2, R * 7, 0.4],
				[Math.PI / 4, R * 4, 0.22],
				[-Math.PI / 4, R * 4, 0.22],
			];
			for (const [rot, len, al] of spikes) {
				ctx.save();
				ctx.rotate(rot);
				const grad = ctx.createLinearGradient(-len, 0, len, 0);
				grad.addColorStop(0, "rgba(255,200,140,0)");
				grad.addColorStop(0.5, `rgba(255,240,215,${al * glow * a})`);
				grad.addColorStop(1, "rgba(255,200,140,0)");
				ctx.fillStyle = grad;
				ctx.globalAlpha = 1;
				ctx.fillRect(-len, -0.9, len * 2, 1.8);
				ctx.restore();
			}
			ctx.restore();
		}

		// Core
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
		const core = ctx.createRadialGradient(x - R * 0.25, y - R * 0.25, R * 0.05, x, y, R);
		core.addColorStop(0, "#ffffff");
		core.addColorStop(0.45, "#fff2cc");
		core.addColorStop(0.85, "#ffc266");
		core.addColorStop(1, "#ff9a4d");
		ctx.fillStyle = core;
		ctx.beginPath();
		ctx.arc(x, y, R, 0, TAU);
		ctx.fill();

		// Thin ring in the note's folder color.
		ctx.globalCompositeOperation = "lighter";
		ctx.globalAlpha = 0.7;
		ctx.strokeStyle = b.color.hex;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(x, y, R + 5, 0, TAU);
		ctx.stroke();
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private drawLabels(): void {
		const ctx = this.ctx;
		const layout = this.layout;
		if (!layout) return;
		const threshold = this.settings.labelThreshold;
		const hl = this.highlight;
		const cands: Array<{ b: Body; p: number }> = [];
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (b.hidden || b.alpha < 0.3) continue;
			if (b.sx < -50 || b.sy < -20 || b.sx > this.w + 50 || b.sy > this.h + 30) continue;
			let p = 0;
			if (i === layout.center) p = 1000;
			else if (i === this.hovered) p = 900;
			else if (this.hovered >= 0) p = this.hoverNeighbors.has(i) ? 100 + b.rad : 0;
			else if (hl && hl.has(b.id)) p = 100 + b.rad;
			else if (!hl && (threshold === 0 || b.rad >= threshold)) p = b.rad;
			if (p > 0) cands.push({ b, p });
		}
		cands.sort((a, b) => b.p - a.p);
		const placed: Array<[number, number, number, number]> = [];
		const max = 220;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (let c = 0; c < cands.length && placed.length < max; c++) {
			const { b, p } = cands[c];
			const isSun = p === 1000;
			const isHover = p === 900;
			const fs = isSun ? 15 : isHover ? 13 : clamp(10 + b.rad / 5, 10, 13);
			ctx.font = `${isSun || isHover ? 600 : 500} ${fs}px ${this.fontFamily}`;
			const text = b.name.length > 32 ? b.name.slice(0, 31) + "…" : b.name;
			const tw = ctx.measureText(text).width;
			const x = b.sx;
			const y = b.sy + (isSun ? b.rad * 1.3 + 12 : b.rad + 5);
			const rect: [number, number, number, number] = [x - tw / 2 - 3, y - 1, tw + 6, fs + 3];
			if (p < 900) {
				let hit = false;
				for (const q of placed) {
					if (rect[0] < q[0] + q[2] && rect[0] + rect[2] > q[0] && rect[1] < q[1] + q[3] && rect[1] + rect[3] > q[1]) {
						hit = true;
						break;
					}
				}
				if (hit) continue;
			}
			placed.push(rect);
			const fadeIn = threshold > 0 && p < 100 ? clamp((b.rad - threshold + 1.5) / 3, 0, 1) : 1;
			ctx.globalAlpha = b.alpha * fadeIn;
			if (isSun || isHover) {
				ctx.shadowColor = isSun ? "rgba(255,190,110,0.9)" : b.color.hex;
				ctx.shadowBlur = 10;
			}
			ctx.fillStyle = isSun ? "#fff4dc" : isHover ? "#ffffff" : "rgba(222,230,255,0.88)";
			ctx.fillText(text, x, y);
			ctx.shadowBlur = 0;
			ctx.shadowColor = "transparent";
		}
		ctx.globalAlpha = 1;
	}
}
