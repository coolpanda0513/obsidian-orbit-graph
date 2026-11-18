import { computeLayout, findHub, GraphData, hash01, OrbitLayout } from "./graph";
import { hexToRgb, mix, rgba, RGB } from "./palette";
import type { OrbitSettings } from "./types";

/**
 * Canvas 2D renderer for the orbit graph. Independent of Obsidian: it takes a
 * graph + settings and reports interactions through callbacks.
 *
 * The scene is styled like a long-exposure astrophotograph: the center note is
 * a black hole with an accretion disk, every other note is a point of light on
 * a circular orbit trailing a streak of its own path, all in one color, with
 * bloom, dust, a Milky Way backdrop and film grain.
 */

export interface RendererCallbacks {
	onHover?(id: string | null, ev: MouseEvent | null): void;
	onClick?(id: string, ev: MouseEvent): void;
	onContextMenu?(id: string, ev: MouseEvent): void;
}

export interface RendererOptions {
	fontFamily?: string;
	monoFamily?: string;
}

interface Body {
	id: string;
	name: string;
	r: number;
	targetR: number;
	angle: number;
	slot: number;
	/** 0 = center, 1..n = orbit, -1 = outer ring. */
	ring: number;
	hidden: boolean;
	size: number;
	degree: number;
	bright: boolean;
	alpha: number;
	sx: number;
	sy: number;
	sz: number;
	ss: number;
	rad: number;
}

interface DiskParticle {
	r: number;
	a: number;
	w: number;
	b: number;
	s: number;
}

interface DustParticle {
	/** Orbit index this grain clusters around, or -1 for the open field. */
	k: number;
	off: number;
	u: number;
	a: number;
	alpha: number;
	s: number;
}

interface Signal {
	edge: number;
	t: number;
	speed: number;
	reverse: boolean;
}

const TAU = Math.PI * 2;
const HOLE_R = 24;
const DISK_IN = HOLE_R * 1.65;
const DISK_OUT = HOLE_R * 4.6;
const FIRST_ORBIT = 215;
const ORBIT_GAP = 95;
const SLOT_SPACING = 22;
const LANE_SPACING = 12;
const TRAIL_SEGMENTS = 10;
const WARM: RGB = [255, 236, 212];

function angleDiff(target: number, current: number): number {
	let d = (target - current) % TAU;
	if (d > Math.PI) d -= TAU;
	if (d < -Math.PI) d += TAU;
	return d;
}

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
	const t = clamp((x - e0) / (e1 - e0), 0, 1);
	return t * t * (3 - 2 * t);
}

function mulberry32(seed: number): () => number {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function gaussian(rand: () => number): number {
	const u = Math.max(1e-9, rand());
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand());
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = Math.max(1, Math.round(w));
	c.height = Math.max(1, Math.round(h));
	return c;
}

function glowSprite(rgb: RGB, falloff: number): HTMLCanvasElement {
	const S = 128;
	const c = makeCanvas(S, S);
	const g = c.getContext("2d")!;
	const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
	grad.addColorStop(0, rgba(rgb, 1));
	grad.addColorStop(0.12 * falloff, rgba(rgb, 0.45));
	grad.addColorStop(0.35 * falloff, rgba(rgb, 0.1));
	grad.addColorStop(Math.min(1, 0.7 * falloff), rgba(rgb, 0.02));
	grad.addColorStop(1, rgba(rgb, 0));
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
	private monoFamily: string;
	private canFilter: boolean;

	private w = 0;
	private h = 0;
	private dpr = 1;

	private graph: GraphData | null = null;
	private layout: OrbitLayout | null = null;
	private centerId: string | null = null;
	private bodies: Body[] = [];
	private bodyById = new Map<string, Body>();
	private reachable = 0;

	private ringRadius: number[] = [];
	private ringLanes: number[] = [];
	private ringAngle: number[] = [];
	private beltR = 0;
	private beltW = 0;
	private beltAngle = 0;
	private outerR = 300;
	private shownOuterR = 300;

	// Camera
	private zoom = 1;
	private tZoom = 1;
	private panX = 0;
	private panY = 0;
	private tPanX = 0;
	private tPanY = 0;
	private tilt: number;
	private tTilt: number;
	private yaw = 0;
	private tYaw = 0;
	private tiltNudge = 0;
	private tTiltNudge = 0;

	// Per-frame projection constants
	private fcx = 0;
	private fcy = 0;
	private fct = 1;
	private fst = 0;
	private fF = 2000;
	private fzoom = 1;
	private px = 0;
	private py = 0;
	private pz = 0;
	private ps = 1;

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

	// Look
	private accent: RGB = [255, 255, 255];
	private accentLight = "#fff";
	private diskColor: RGB = WARM;
	private glow!: HTMLCanvasElement;
	private haloGlow!: HTMLCanvasElement;
	private background: HTMLCanvasElement | null = null;
	private bgMargin = 60;
	private grain: HTMLCanvasElement;
	private bloomA: HTMLCanvasElement | null = null;
	private bloomB: HTMLCanvasElement | null = null;
	private disk: DiskParticle[] = [];
	private dust: DustParticle[] = [];
	private signals: Signal[] = [];
	private waves: number[] = [];

	private time = 0;
	private last = 0;
	/** Smoothed frame time, used to drop bloom on machines that can't keep up. */
	private frameTime = 1 / 60;
	private frames = 0;
	private bloomBudgetExceeded = false;
	private drawn = false;
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
		this.canFilter = typeof (ctx as unknown as { filter?: unknown }).filter === "string";
		this.settings = { ...settings };
		this.callbacks = callbacks;
		this.fontFamily = options.fontFamily || "system-ui, sans-serif";
		this.monoFamily = options.monoFamily || "ui-monospace, Menlo, monospace";
		this.tilt = this.tTilt = (settings.tilt * Math.PI) / 180;
		this.setAccent(settings.accentColor);
		this.grain = this.makeGrain();
		this.makeDisk();

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
	 * Replace the graph. Bodies are matched by id so existing notes glide to
	 * their new orbits instead of jumping. Pass `center` to also move the center.
	 */
	setGraph(graph: GraphData, center?: string | null): void {
		const changed = center !== undefined && center !== this.centerId;
		if (center !== undefined) this.centerId = center;
		this.graph = graph;
		const old = this.bodyById;
		const bodies: Body[] = [];
		const byId = new Map<string, Body>();
		const degrees = graph.nodes.map((n) => n.degree).sort((a, b) => b - a);
		const brightCut = Math.max(6, degrees[Math.min(degrees.length - 1, 4)] || 0);
		for (const node of graph.nodes) {
			let b = old.get(node.path);
			if (!b) {
				b = {
					id: node.path,
					name: node.name,
					r: -1,
					targetR: 0,
					angle: 0,
					slot: 0,
					ring: -1,
					hidden: false,
					size: 0,
					degree: 0,
					bright: false,
					alpha: 0,
					sx: 0,
					sy: 0,
					sz: 0,
					ss: 1,
					rad: 0,
				};
			}
			b.name = node.name;
			b.degree = node.degree;
			b.size = Math.min(5.5, 1.5 + Math.sqrt(node.degree) * 0.8);
			b.bright = node.degree >= brightCut;
			bodies.push(b);
			byId.set(node.path, b);
		}
		this.bodies = bodies;
		this.bodyById = byId;
		if (this.hovered >= bodies.length) this.setHovered(-1, null);
		this.relayout(changed);
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

	setHighlight(ids: Set<string> | null): void {
		this.highlight = ids;
	}

	updateSettings(settings: OrbitSettings): void {
		const prev = this.settings;
		this.settings = { ...settings };
		this.tTilt = (settings.tilt * Math.PI) / 180;
		if (prev.maxOrbits !== settings.maxOrbits || prev.showOrphans !== settings.showOrphans) {
			this.relayout(false, true);
		}
		if (settings.bloom && !prev.bloom) {
			this.bloomBudgetExceeded = false;
			this.frames = 0;
		}
		if (prev.starDensity !== settings.starDensity || prev.filmGrain !== settings.filmGrain) this.makeBackground();
		if (prev.showSignals !== settings.showSignals) this.resetSignals();
		if (prev.accentColor !== settings.accentColor) {
			this.setAccent(settings.accentColor);
			this.makeBackground();
		}
		if (!settings.parallax) this.tYaw = this.tTiltNudge = 0;
	}

	fit(immediate = false): void {
		if (!this.w || !this.h) return;
		const outer = Math.max(this.outerR, FIRST_ORBIT);
		const F = this.focal();
		const ct = Math.cos(this.tTilt);
		const st = Math.sin(this.tTilt);
		const sNear = F / (F - outer * st);
		const zx = (this.w * 0.45) / outer;
		const zy = (this.h * 0.4) / Math.max(outer * ct * sNear, outer * 0.25);
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

	// ------------------------------------------------------------------ assets

	private setAccent(hex: string): void {
		const rgb = /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex || "") ? hexToRgb(hex) : null;
		this.accent = rgb || [255, 255, 255];
		this.accentLight = rgba(mix(this.accent, [255, 255, 255], 0.55), 1);
		this.diskColor = mix(this.accent, WARM, 0.55);
		this.glow = glowSprite(this.accent, 1);
		this.haloGlow = glowSprite(mix(this.diskColor, [255, 255, 255], 0.2), 0.75);
	}

	private makeGrain(): HTMLCanvasElement {
		const S = 160;
		const c = makeCanvas(S, S);
		const g = c.getContext("2d")!;
		const img = g.createImageData(S, S);
		const rand = mulberry32(7);
		for (let i = 0; i < img.data.length; i += 4) {
			const v = rand();
			img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
			img.data[i + 3] = v > 0.5 ? Math.round((v - 0.5) * 2 * 255) : 0;
		}
		g.putImageData(img, 0, 0);
		return c;
	}

	private makeDisk(): void {
		const rand = mulberry32(99);
		this.disk = [];
		for (let i = 0; i < 1600; i++) {
			const u = Math.pow(rand(), 1.7);
			const r = DISK_IN + (DISK_OUT - DISK_IN) * u;
			this.disk.push({
				r,
				a: rand() * TAU,
				w: 0.9 * Math.pow(DISK_IN / r, 1.5),
				b: (0.25 + rand() * 0.75) * Math.pow(DISK_IN / r, 1.1),
				s: 0.45 + rand() * rand() * 1.1,
			});
		}
	}

	private makeDust(): void {
		const rand = mulberry32(2024);
		const rings = Math.max(0, this.ringRadius.length - 1);
		this.dust = [];
		const count = 2600;
		for (let i = 0; i < count; i++) {
			const clustered = rings > 0 && rand() < 0.62;
			this.dust.push({
				k: clustered ? 1 + Math.floor(rand() * rings) : -1,
				off: gaussian(rand) * 16,
				u: Math.pow(rand(), 0.8),
				a: rand() * TAU,
				alpha: 0.05 + Math.pow(rand(), 3) * 0.35,
				s: 0.5 + rand() * 0.7,
			});
		}
	}

	/** Static backdrop: deep space with a faint Milky Way band and dark dust lanes. */
	private makeBackground(): void {
		const { w, h } = this;
		if (!w || !h) return;
		const m = this.bgMargin;
		const W = w + m * 2;
		const H = h + m * 2;
		const c = makeCanvas(W, H);
		const g = c.getContext("2d")!;
		g.fillStyle = "#030304";
		g.fillRect(0, 0, W, H);
		const density = this.settings.starDensity;
		if (density > 0) this.paintSky(g, W, H, density);
		if (this.settings.filmGrain) {
			// Vignette and grain are baked into the backdrop so they cost nothing per frame.
			const vig = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.55);
			vig.addColorStop(0, "rgba(0,0,0,0)");
			vig.addColorStop(1, "rgba(0,0,0,0.75)");
			g.globalCompositeOperation = "source-over";
			g.fillStyle = vig;
			g.fillRect(0, 0, W, H);
			const pattern = g.createPattern(this.grain, "repeat");
			if (pattern) {
				g.globalCompositeOperation = "lighter";
				g.globalAlpha = 0.05;
				g.fillStyle = pattern;
				g.fillRect(0, 0, W, H);
				g.globalAlpha = 1;
			}
		}
		this.background = c;
	}

	private paintSky(g: CanvasRenderingContext2D, W: number, H: number, density: number): void {
		const rand = mulberry32(31337);
		const ang = -0.42;
		const dx = Math.cos(ang);
		const dy = Math.sin(ang);
		const cx = W * 0.5;
		const cy = H * 0.42;
		const len = Math.hypot(W, H) * 0.65;
		const band = Math.min(W, H) * 0.13;
		const haze = mix(this.accent, WARM, 0.3);

		// Diffuse glow of unresolved stars
		g.globalCompositeOperation = "lighter";
		for (let i = 0; i < 60; i++) {
			const t = (rand() * 2 - 1) * len;
			const o = gaussian(rand) * band * 0.6;
			const x = cx + dx * t - dy * o;
			const y = cy + dy * t + dx * o;
			const r = band * (0.6 + rand() * 1.4);
			const grad = g.createRadialGradient(x, y, 0, x, y, r);
			grad.addColorStop(0, rgba(haze, 0.03 * density));
			grad.addColorStop(1, rgba(haze, 0));
			g.fillStyle = grad;
			g.fillRect(x - r, y - r, r * 2, r * 2);
		}
		// Dark dust lanes along the band
		g.globalCompositeOperation = "source-over";
		for (let i = 0; i < 40; i++) {
			const t = (rand() * 2 - 1) * len;
			const o = (gaussian(rand) * 0.25 + 0.1) * band;
			const x = cx + dx * t - dy * o;
			const y = cy + dy * t + dx * o;
			const r = band * (0.15 + rand() * 0.45);
			const grad = g.createRadialGradient(x, y, 0, x, y, r);
			grad.addColorStop(0, "rgba(3,3,4,0.3)");
			grad.addColorStop(1, "rgba(3,3,4,0)");
			g.fillStyle = grad;
			g.fillRect(x - r, y - r, r * 2, r * 2);
		}
		// Resolved stars: dense in the band, sparse elsewhere
		g.globalCompositeOperation = "lighter";
		const bandStars = Math.round(((W * H) / 260) * density);
		for (let i = 0; i < bandStars; i++) {
			const t = (rand() * 2 - 1) * len;
			const o = gaussian(rand) * band * 0.75;
			const x = cx + dx * t - dy * o;
			const y = cy + dy * t + dx * o;
			const a = (0.04 + Math.pow(rand(), 4) * 0.5) * Math.exp(-(o * o) / (2 * band * band));
			g.fillStyle = rgba(rand() < 0.3 ? WARM : [235, 240, 255], a);
			g.fillRect(x, y, 0.8, 0.8);
		}
		const fieldStars = Math.round(((W * H) / 2600) * density);
		for (let i = 0; i < fieldStars; i++) {
			const x = rand() * W;
			const y = rand() * H;
			const big = Math.pow(rand(), 6);
			g.fillStyle = `rgba(240,244,255,${0.06 + big * 0.6})`;
			const s = 0.6 + big * 1.2;
			g.fillRect(x, y, s, s);
			if (big > 0.5) {
				const r = 4 + big * 6;
				g.globalAlpha = 0.25 * big;
				g.drawImage(this.glow, x - r, y - r, r * 2, r * 2);
				g.globalAlpha = 1;
			}
		}
	}

	// ------------------------------------------------------------------ layout

	private focal(): number {
		return Math.max(2200, this.outerR * 5);
	}

	private relayout(centerChanged = false, refit = false): void {
		const graph = this.graph;
		if (!graph || graph.nodes.length === 0) {
			this.layout = null;
			this.ringRadius = [];
			this.signals = [];
			return;
		}
		let center = this.centerId !== null ? graph.byId.get(this.centerId) : undefined;
		if (center === undefined) {
			const hub = findHub(graph);
			center = hub !== null ? graph.byId.get(hub) ?? 0 : 0;
		}
		const prevCenter = this.layout?.center;
		const layout = computeLayout(graph, center, this.settings.maxOrbits);
		this.layout = layout;

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
		const ringCountChanged = radii.length !== this.ringRadius.length;
		this.ringRadius = radii;
		this.ringLanes = lanesArr;
		while (this.ringAngle.length < radii.length) this.ringAngle.push(Math.random() * TAU);

		let reachable = 0;
		for (let k = 0; k < layout.rings.length; k++) {
			const ring = layout.rings[k];
			const n = ring.length;
			const lanes = lanesArr[k];
			if (k > 0) reachable += n;
			for (let i = 0; i < n; i++) {
				const b = this.bodies[ring[i]];
				b.ring = k;
				b.hidden = false;
				b.slot = n ? (TAU * i) / n : 0;
				const lane = lanes > 1 ? i % lanes : 0;
				const jitter = k === 0 ? 0 : (hash01(b.id, 7) - 0.5) * 4;
				b.targetR = radii[k] + lane * LANE_SPACING + jitter;
			}
		}
		this.reachable = reachable;

		const belt = layout.belt;
		if (belt.length && this.settings.showOrphans) {
			this.beltR = (outer || FIRST_ORBIT) + ORBIT_GAP * 1.2;
			this.beltW = Math.max(40, (belt.length * SLOT_SPACING * LANE_SPACING) / (TAU * this.beltR));
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

		for (const b of this.bodies) {
			if (b.r >= 0) continue;
			if (this.firstLayout) {
				b.r = DISK_OUT * (0.6 + hash01(b.id, 5) * 0.6);
				b.angle = this.targetAngle(b) - 2.4 - hash01(b.id, 3) * 1.5;
			} else {
				b.r = b.targetR + 120;
				b.angle = this.targetAngle(b);
			}
			b.alpha = 0;
		}

		if (ringCountChanged || !this.dust.length) this.makeDust();
		this.resetSignals();

		if (this.firstLayout && this.w) {
			this.firstLayout = false;
			this.shownOuterR = this.outerR;
			this.fit(true);
			this.zoom = this.tZoom * 1.9;
			this.waves.push(0);
		} else if (!this.firstLayout && (centerChanged || refit)) {
			this.fit();
			if (centerChanged && prevCenter !== layout.center) this.waves.push(0);
		}
	}

	private targetAngle(b: Body): number {
		if (b.ring > 0) return (this.ringAngle[b.ring] || 0) + b.slot;
		if (b.ring === -1) return this.beltAngle + b.slot;
		return 0;
	}

	private omega(r: number): number {
		return 0.06 * Math.pow(200 / Math.max(r, 60), 1.5);
	}

	private dustRadius(p: DustParticle): number {
		if (p.k > 0 && p.k < this.ringRadius.length) {
			const band = (this.ringLanes[p.k] - 1) * LANE_SPACING;
			return this.ringRadius[p.k] + band / 2 + p.off;
		}
		return DISK_OUT * 1.6 + p.u * (this.shownOuterR * 1.12 - DISK_OUT * 1.6);
	}

	private resetSignals(): void {
		this.signals = [];
		const edges = this.graph?.edges.length || 0;
		if (!this.settings.showSignals || !edges) return;
		const n = Math.min(18, Math.ceil(edges / 5));
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
		if (this.hovered >= 0 && Math.random() < 0.7) {
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
		s.speed = 0.15 + Math.random() * 0.2;
		const [a, b] = graph.edges[s.edge];
		const ra = this.bodies[a]?.ring ?? 0;
		const rb = this.bodies[b]?.ring ?? 0;
		s.reverse = (ra < 0 ? 99 : ra) > (rb < 0 ? 99 : rb);
	}

	// ------------------------------------------------------------------ sizing

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
		this.bloomA = makeCanvas(w / 3, h / 3);
		this.bloomB = makeCanvas(w / 8, h / 8);
		this.makeBackground();
		if (this.firstLayout && this.layout) {
			this.firstLayout = false;
			this.shownOuterR = this.outerR;
			this.fit(true);
			this.zoom = this.tZoom * 1.9;
			this.waves.push(0);
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
			if (this.settings.parallax && e.pointerType === "mouse") {
				this.tYaw = ((p.x / this.w) - 0.5) * 0.22;
				this.tTiltNudge = ((p.y / this.h) - 0.5) * 0.07;
			}
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
			this.tYaw = 0;
			this.tTiltNudge = 0;
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
				const z = clamp(this.tZoom * Math.exp(-delta * 0.0015), 0.02, 8);
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
		if (idx >= 0) for (const s of this.signals) if (Math.random() < 0.6) this.spawnSignal(s);
		this.callbacks.onHover?.(idx >= 0 ? this.bodies[idx].id : null, ev);
	}

	private hitTest(x: number, y: number): number {
		if (!this.layout || !this.drawn) return -1;
		let best = -1;
		let bestZ = -Infinity;
		// The black hole itself stands for the center note.
		const R = HOLE_R * this.fzoom * 1.3 + 4;
		const hx = x - this.fcx;
		const hy = y - this.fcy;
		if (hx * hx + hy * hy <= R * R) return this.layout.center;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (b.hidden || b.alpha < 0.05 || i === this.layout.center) continue;
			const r = Math.max(b.rad, 4) + 4;
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
		const raw = this.last ? (t - this.last) / 1000 : 0.016;
		const dt = clamp(raw, 0, 0.05);
		this.last = t;
		if (raw < 0.25) {
			this.frameTime += (raw - this.frameTime) * 0.05;
			this.frames++;
			if (this.frames > 120 && this.frameTime > 1 / 35 && !this.bloomBudgetExceeded) {
				this.bloomBudgetExceeded = true;
			}
		}
		if (!this.w || !this.h) {
			this.resize();
			return;
		}
		this.update(dt);
		this.draw();
		this.drawn = true;
	};

	private update(dt: number): void {
		this.time += dt;
		const speed = this.settings.orbitSpeed;
		for (let k = 1; k < this.ringRadius.length; k++) {
			this.ringAngle[k] += this.omega(this.ringRadius[k]) * dt * speed;
		}
		this.beltAngle += this.omega(this.beltR || 600) * dt * speed * 0.8;

		const diskSpeed = Math.max(speed, 0.15);
		for (const p of this.disk) p.a += p.w * dt * diskSpeed;
		if (this.settings.dust) {
			for (const p of this.dust) p.a += this.omega(this.dustRadius(p)) * dt * speed;
		}

		const ease = 1 - Math.exp(-dt * 1.6);
		const fade = 1 - Math.exp(-dt * 5);
		const hovering = this.hovered >= 0;
		const hl = this.highlight;
		const center = this.layout?.center ?? -1;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			b.r += (b.targetR - b.r) * ease;
			b.angle += angleDiff(this.targetAngle(b), b.angle) * ease;
			let ta = b.hidden ? 0 : b.ring === -1 ? 0.5 : 1;
			if (!b.hidden && i !== center) {
				if (hovering) ta = i === this.hovered || this.hoverNeighbors.has(i) ? 1 : 0.18;
				else if (hl) ta = hl.has(b.id) ? 1 : 0.14;
			}
			b.alpha += (ta - b.alpha) * fade;
		}

		const cam = 1 - Math.exp(-dt * 6);
		const slow = 1 - Math.exp(-dt * 1.5);
		this.zoom += (this.tZoom - this.zoom) * cam;
		this.panX += (this.tPanX - this.panX) * cam;
		this.panY += (this.tPanY - this.panY) * cam;
		this.tilt += (this.tTilt - this.tilt) * cam;
		this.yaw += (this.tYaw - this.yaw) * slow;
		this.tiltNudge += (this.tTiltNudge - this.tiltNudge) * slow;
		this.shownOuterR += (this.outerR - this.shownOuterR) * ease;

		for (const s of this.signals) {
			s.t += dt * s.speed;
			if (s.t >= 1) this.spawnSignal(s);
		}
		for (let i = 0; i < this.waves.length; i++) this.waves[i] += dt;
		this.waves = this.waves.filter((t) => t < 3.2);
	}

	/** Project a point on the orbit plane (radius, angle) into this.px/py/pz/ps. */
	private project(r: number, a: number): void {
		const x = r * Math.cos(a + this.yaw);
		const z = r * Math.sin(a + this.yaw);
		const zt = z * this.fst;
		const s = this.fF / (this.fF - zt);
		this.px = this.fcx + x * s * this.fzoom;
		this.py = this.fcy + z * this.fct * s * this.fzoom;
		this.pz = zt;
		this.ps = s;
	}

	private draw(): void {
		const ctx = this.ctx;
		const { w, h } = this;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
		ctx.filter = "none";
		this.drawBackground();

		const layout = this.layout;
		if (!layout) return;

		const tilt = clamp(this.tilt + this.tiltNudge, 0, 1.45);
		this.fcx = w / 2 + this.panX;
		this.fcy = h / 2 + this.panY;
		this.fct = Math.cos(tilt);
		this.fst = Math.sin(tilt);
		this.fF = this.focal();
		this.fzoom = this.zoom;
		const zs = Math.sqrt(this.zoom);
		for (const b of this.bodies) {
			this.project(b.r, b.angle);
			b.sx = this.px;
			b.sy = this.py;
			b.sz = this.pz;
			b.ss = this.ps;
			const size = b.ring === -1 ? b.size * 0.7 : b.size;
			b.rad = Math.max(0.8, size * this.ps * zs);
		}

		if (this.settings.dust) this.drawDust();
		if (this.settings.showOrbits) this.drawOrbits();
		this.drawWaves();
		if (this.settings.showLinks) this.drawLinks();
		if (this.settings.showSignals && this.settings.showLinks) this.drawSignals();
		if (this.settings.trails) this.drawTrails();

		const order = this.order;
		order.length = 0;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (!b.hidden || b.alpha > 0.01) order.push(i);
		}
		order.sort((a, b) => this.bodies[a].sz - this.bodies[b].sz);
		ctx.globalCompositeOperation = "lighter";
		let holeDrawn = false;
		for (const i of order) {
			const b = this.bodies[i];
			if (!holeDrawn && b.sz >= 0) {
				this.drawHole();
				holeDrawn = true;
				ctx.globalCompositeOperation = "lighter";
			}
			this.drawBody(b, i === this.hovered, i === layout.center);
		}
		if (!holeDrawn) this.drawHole();

		if (this.bloomActive() && this.drawBloom()) this.restoreShadow();
		this.drawLabels();
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private drawBackground(): void {
		const ctx = this.ctx;
		const { w, h } = this;
		if (!this.background) {
			ctx.fillStyle = "#030304";
			ctx.fillRect(0, 0, w, h);
			return;
		}
		const m = this.bgMargin;
		const ox = clamp(this.panX * 0.03 - this.yaw * 120, -m, m);
		const oy = clamp(this.panY * 0.03 + this.tiltNudge * 300, -m, m);
		ctx.drawImage(this.background, -m + ox, -m + oy);
	}

	/**
	 * Bloom without reading the frame back: the bright parts of the scene (notes,
	 * the photon ring and disk) are redrawn as simple shapes into a small canvas,
	 * blurred there, and added on top of the frame.
	 */
	private drawBloom(): boolean {
		const a = this.bloomA;
		const b = this.bloomB;
		if (!a || !b || !this.canFilter || !this.layout) return false;
		const ga = a.getContext("2d")!;
		const gb = b.getContext("2d")!;
		const k = a.width / this.w;
		ga.setTransform(1, 0, 0, 1, 0, 0);
		ga.globalCompositeOperation = "source-over";
		ga.globalAlpha = 1;
		ga.filter = "none";
		ga.clearRect(0, 0, a.width, a.height);
		ga.setTransform(k, 0, 0, k, 0, 0);
		ga.globalCompositeOperation = "lighter";
		ga.fillStyle = this.accentLight;
		const center = this.layout.center;
		for (let i = 0; i < this.bodies.length; i++) {
			const body = this.bodies[i];
			if (body.hidden || body.alpha < 0.05 || i === center) continue;
			const r = Math.max(1.2, body.rad * (i === this.hovered ? 2.2 : 1.4));
			ga.globalAlpha = body.alpha * (body.bright ? 1 : 0.7);
			ga.beginPath();
			ga.arc(body.sx, body.sy, r, 0, TAU);
			ga.fill();
		}
		// Hole: photon ring + disk
		const R = HOLE_R * this.fzoom;
		ga.globalAlpha = 0.9;
		ga.strokeStyle = rgba(mix(this.diskColor, [255, 255, 255], 0.5), 1);
		ga.lineWidth = Math.max(1, R * 0.15);
		ga.beginPath();
		ga.arc(this.fcx, this.fcy, R * 1.1, 0, TAU);
		ga.stroke();
		ga.globalAlpha = 0.35;
		ga.lineWidth = Math.max(1.5, (DISK_OUT - DISK_IN) * this.fzoom * 0.3);
		ga.beginPath();
		ga.ellipse(this.fcx, this.fcy, (DISK_IN + DISK_OUT) * 0.45 * this.fzoom, (DISK_IN + DISK_OUT) * 0.45 * this.fzoom * this.fct, 0, 0, TAU);
		ga.stroke();

		// Blur: tight pass at 1/3 resolution, wide pass at 1/8.
		gb.globalCompositeOperation = "copy";
		gb.filter = "blur(2.5px)";
		gb.drawImage(a, 0, 0, b.width, b.height);
		gb.filter = "none";
		ga.setTransform(1, 0, 0, 1, 0, 0);
		ga.globalAlpha = 0.8;
		ga.globalCompositeOperation = "copy";
		ga.filter = "blur(2px)";
		ga.drawImage(a, 0, 0);
		ga.filter = "none";
		// Fold the wide pass into the tight one so the frame gets a single composite.
		ga.globalCompositeOperation = "lighter";
		ga.globalAlpha = 1;
		ga.drawImage(b, 0, 0, a.width, a.height);

		const ctx = this.ctx;
		ctx.save();
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.globalCompositeOperation = "lighter";
		ctx.imageSmoothingEnabled = true;
		ctx.globalAlpha = Math.min(1, 0.6 * this.settings.glowIntensity);
		ctx.drawImage(a, 0, 0, this.w, this.h);
		ctx.restore();
		return true;
	}

	private bloomActive(): boolean {
		return this.settings.bloom && !this.bloomBudgetExceeded && this.canFilter && !!this.bloomA;
	}

	/** Bloom bleeds light into the hole; put the shadow and the near disk back on top. */
	private restoreShadow(): void {
		const ctx = this.ctx;
		const R = HOLE_R * this.fzoom;
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
		const core = ctx.createRadialGradient(this.fcx, this.fcy, 0, this.fcx, this.fcy, R);
		core.addColorStop(0, "rgba(0,0,0,0.95)");
		core.addColorStop(0.8, "rgba(0,0,0,0.9)");
		core.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = core;
		ctx.beginPath();
		ctx.arc(this.fcx, this.fcy, R, 0, TAU);
		ctx.fill();
		ctx.globalCompositeOperation = "lighter";
		this.drawDiskBand(true);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private arcPath(r: number, a0: number, a1: number, steps: number): void {
		const ctx = this.ctx;
		ctx.beginPath();
		for (let i = 0; i <= steps; i++) {
			// View angle (already includes yaw): project without adding yaw again.
			const v = a0 + ((a1 - a0) * i) / steps;
			const x = r * Math.cos(v);
			const z = r * Math.sin(v);
			const s = this.fF / (this.fF - z * this.fst);
			const sx = this.fcx + x * s * this.fzoom;
			const sy = this.fcy + z * this.fct * s * this.fzoom;
			if (i === 0) ctx.moveTo(sx, sy);
			else ctx.lineTo(sx, sy);
		}
	}

	private drawDust(): void {
		const ctx = this.ctx;
		const dim = this.hovered >= 0 || this.highlight ? 0.45 : 1;
		ctx.globalCompositeOperation = "lighter";
		ctx.fillStyle = this.accentLight;
		for (const p of this.dust) {
			const r = this.dustRadius(p);
			if (r < DISK_OUT * 1.3) continue;
			this.project(r, p.a);
			const depth = clamp(0.6 + (this.ps - 1) * 3, 0.35, 1.1);
			ctx.globalAlpha = p.alpha * depth * dim;
			const s = p.s * Math.min(1.6, this.ps * Math.sqrt(this.fzoom) * 1.2);
			ctx.fillRect(this.px, this.py, s, s);
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private drawOrbits(): void {
		const ctx = this.ctx;
		const dim = this.hovered >= 0 || this.highlight ? 0.5 : 1;
		ctx.lineWidth = 1;
		for (let k = 1; k < this.ringRadius.length; k++) {
			const band = (this.ringLanes[k] - 1) * LANE_SPACING;
			this.arcPath(this.ringRadius[k] + band / 2, 0, TAU, 220);
			ctx.strokeStyle = rgba(this.accent, 0.075 * dim);
			ctx.stroke();
		}
		if (this.beltW > 0) {
			ctx.setLineDash([1, 6]);
			this.arcPath(this.beltR + this.beltW / 2, 0, TAU, 220);
			ctx.strokeStyle = rgba(this.accent, 0.08 * dim);
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	/** Gravitational ripple that runs outward when the center changes. */
	private drawWaves(): void {
		const ctx = this.ctx;
		ctx.globalCompositeOperation = "lighter";
		for (const t of this.waves) {
			const k = clamp(t / 3.2, 0, 1);
			const e = 1 - Math.pow(1 - k, 3);
			const r = DISK_OUT + (this.shownOuterR * 1.1 - DISK_OUT) * e;
			const a = Math.pow(1 - k, 2);
			this.arcPath(r, 0, TAU, 220);
			ctx.strokeStyle = rgba(this.accent, 0.08 * a);
			ctx.lineWidth = 14 * this.fzoom;
			ctx.stroke();
			ctx.strokeStyle = rgba(this.accent, 0.45 * a);
			ctx.lineWidth = 1;
			ctx.stroke();
		}
		ctx.globalCompositeOperation = "source-over";
	}

	private controlPoint(a: Body, b: Body): [number, number] {
		const mx = (a.sx + b.sx) / 2;
		const my = (a.sy + b.sy) / 2;
		return [mx + (this.fcx - mx) * 0.14, my + (this.fcy - my) * 0.14];
	}

	private drawLinks(): void {
		const ctx = this.ctx;
		const graph = this.graph;
		if (!graph) return;
		const bodies = this.bodies;
		const focus = this.hovered >= 0 || this.highlight !== null;
		const base = this.settings.linkOpacity * (focus ? 0.25 : 1);
		ctx.globalCompositeOperation = "lighter";
		ctx.lineWidth = 1;
		if (base > 0.001) {
			ctx.strokeStyle = rgba(this.accent, 0.085 * base);
			ctx.beginPath();
			for (const [ai, bi] of graph.edges) {
				const a = bodies[ai];
				const b = bodies[bi];
				if (a.hidden || b.hidden) continue;
				const [qx, qy] = this.controlPoint(a, b);
				ctx.moveTo(a.sx, a.sy);
				ctx.quadraticCurveTo(qx, qy, b.sx, b.sy);
			}
			ctx.stroke();
		}

		if (this.hovered >= 0) {
			const hb = bodies[this.hovered];
			ctx.beginPath();
			for (const n of this.hoverNeighbors) {
				const b = bodies[n];
				if (b.hidden) continue;
				const [qx, qy] = this.controlPoint(hb, b);
				ctx.moveTo(hb.sx, hb.sy);
				ctx.quadraticCurveTo(qx, qy, b.sx, b.sy);
			}
			ctx.strokeStyle = rgba(this.accent, 0.12);
			ctx.lineWidth = 4;
			ctx.stroke();
			ctx.strokeStyle = rgba(this.accent, 0.55);
			ctx.lineWidth = 1;
			ctx.stroke();
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
			ctx.globalAlpha = Math.sin(Math.PI * t) * 0.7 * Math.min(a.alpha, b.alpha);
			const g = 5;
			ctx.drawImage(this.glow, x - g, y - g, g * 2, g * 2);
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	/**
	 * Long-exposure streaks: each note trails a fading arc of its own orbit.
	 * Segments are batched by fade step and brightness so the whole field is a
	 * few dozen strokes, whatever the vault size.
	 */
	private drawTrails(): void {
		const ctx = this.ctx;
		const K = TRAIL_SEGMENTS;
		const paths: Path2D[] = [];
		for (let i = 0; i < K * 3; i++) paths.push(new Path2D());
		const center = this.layout?.center ?? -1;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (b.hidden || b.alpha < 0.05 || i === center || b.r < DISK_OUT) continue;
			const bucket = b.alpha > 0.66 ? 0 : b.alpha > 0.3 ? 1 : 2;
			const len = Math.min(0.75, 110 / b.r) * (b.ring === -1 ? 0.6 : 1);
			this.project(b.r, b.angle);
			let lx = this.px;
			let ly = this.py;
			for (let k = 0; k < K; k++) {
				this.project(b.r, b.angle - (len * (k + 1)) / K);
				const p = paths[bucket * K + k];
				p.moveTo(lx, ly);
				p.lineTo(this.px, this.py);
				lx = this.px;
				ly = this.py;
			}
		}
		const mult = [1, 0.45, 0.12];
		ctx.globalCompositeOperation = "lighter";
		ctx.lineCap = "round";
		for (let bucket = 0; bucket < 3; bucket++) {
			for (let k = 0; k < K; k++) {
				const f = Math.pow(1 - k / K, 1.8);
				ctx.strokeStyle = rgba(this.accent, 0.42 * f * mult[bucket]);
				ctx.lineWidth = 1.3 - (k / K) * 0.6;
				ctx.stroke(paths[bucket * K + k]);
			}
		}
		ctx.lineCap = "butt";
		ctx.globalCompositeOperation = "source-over";
	}

	private drawBody(b: Body, hovered: boolean, isCenter: boolean): void {
		const ctx = this.ctx;
		const depth = clamp(0.62 + (b.ss - 1) * 2.5, 0.42, 1);
		let alpha = b.alpha * depth;
		// A note falling into the center fades as it crosses the disk.
		if (isCenter) alpha *= smoothstep(DISK_IN, DISK_OUT * 1.4, b.r);
		if (alpha < 0.01) return;
		const rad = b.rad * (hovered ? 1.5 : 1);
		const glow = this.settings.glowIntensity;

		if (glow > 0) {
			ctx.globalAlpha = Math.min(1, alpha * 0.42 * glow * (hovered ? 2 : 1));
			const g = rad * 8 + 4;
			ctx.drawImage(this.glow, b.sx - g, b.sy - g, g * 2, g * 2);
		}
		// Diffraction spikes on the brightest few, like stars through a telescope.
		if (b.bright && rad > 1.6 && glow > 0) {
			const L = rad * 9;
			ctx.globalAlpha = Math.min(1, alpha * 0.5 * glow);
			ctx.fillStyle = this.accentLight;
			const grad = ctx.createLinearGradient(b.sx - L, 0, b.sx + L, 0);
			grad.addColorStop(0, rgba(this.accent, 0));
			grad.addColorStop(0.5, rgba(this.accent, 0.9));
			grad.addColorStop(1, rgba(this.accent, 0));
			ctx.fillStyle = grad;
			ctx.fillRect(b.sx - L, b.sy - 0.5, L * 2, 1);
			const gradV = ctx.createLinearGradient(0, b.sy - L, 0, b.sy + L);
			gradV.addColorStop(0, rgba(this.accent, 0));
			gradV.addColorStop(0.5, rgba(this.accent, 0.9));
			gradV.addColorStop(1, rgba(this.accent, 0));
			ctx.fillStyle = gradV;
			ctx.fillRect(b.sx - 0.5, b.sy - L, 1, L * 2);
		}
		ctx.globalAlpha = alpha * 0.9;
		ctx.fillStyle = this.accentLight;
		ctx.beginPath();
		ctx.arc(b.sx, b.sy, rad, 0, TAU);
		ctx.fill();
		if (hovered) {
			ctx.globalAlpha = 0.5;
			ctx.strokeStyle = this.accentLight;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(b.sx, b.sy, rad + 5 + Math.sin(this.time * 3) * 1, 0, TAU);
			ctx.stroke();
		}
	}

	/**
	 * The smooth part of the accretion disk: a gradient-filled ring drawn in the
	 * tilted plane (via a vertical squash), split into far and near halves so
	 * the hole can sit between them.
	 */
	private drawDiskBand(front: boolean): void {
		const ctx = this.ctx;
		const glow = Math.max(0.3, this.settings.glowIntensity);
		const big = DISK_OUT * 2;
		ctx.save();
		ctx.globalAlpha = 1;
		ctx.translate(this.fcx, this.fcy);
		ctx.scale(this.fzoom, this.fzoom * Math.max(0.02, this.fct));
		ctx.beginPath();
		if (front) ctx.rect(-big, 0, big * 2, big);
		else ctx.rect(-big, -big, big * 2, big);
		ctx.clip();
		ctx.beginPath();
		ctx.arc(0, 0, DISK_OUT, 0, TAU);
		ctx.arc(0, 0, DISK_IN * 0.92, 0, TAU, true);
		const i0 = (DISK_IN * 0.92) / DISK_OUT;
		const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, DISK_OUT);
		grad.addColorStop(i0, rgba(this.diskColor, 0));
		grad.addColorStop(i0 + 0.04, rgba(mix(this.diskColor, [255, 255, 255], 0.5), 0.6 * glow));
		grad.addColorStop(i0 + 0.16, rgba(this.diskColor, 0.3 * glow));
		grad.addColorStop(0.62, rgba(this.diskColor, 0.07 * glow));
		grad.addColorStop(1, rgba(this.diskColor, 0));
		ctx.fillStyle = grad;
		ctx.fill("evenodd");
		ctx.restore();
	}

	private drawDiskParticles(front: boolean): void {
		const ctx = this.ctx;
		const glow = Math.max(0.3, this.settings.glowIntensity);
		const zs = Math.min(1.8, Math.sqrt(this.fzoom) * 1.3);
		ctx.fillStyle = rgba(mix(this.diskColor, [255, 255, 255], 0.5), 1);
		for (const p of this.disk) {
			const v = p.a + this.yaw;
			const behind = Math.sin(v) < 0;
			if (behind === front) continue;
			this.project(p.r, p.a);
			// Relativistic beaming: the side moving toward us is brighter.
			const doppler = 1 + 0.4 * Math.cos(v);
			ctx.globalAlpha = Math.min(1, p.b * doppler * 0.4 * glow);
			const s = p.s * zs;
			ctx.fillRect(this.px - s / 2, this.py - s / 2, s, s);
		}
		ctx.globalAlpha = 1;
	}

	/** The center: a black hole with an accretion disk, lensed halo and photon ring. */
	private drawHole(): void {
		const ctx = this.ctx;
		const layout = this.layout;
		if (!layout) return;
		const x = this.fcx;
		const y = this.fcy;
		const R = HOLE_R * this.fzoom;
		const glow = this.settings.glowIntensity;
		const breathe = 1 + 0.04 * Math.sin(this.time * 0.8);

		ctx.globalCompositeOperation = "lighter";
		if (glow > 0) {
			ctx.globalAlpha = Math.min(1, 0.14 * glow);
			let g = R * 26 * breathe;
			ctx.drawImage(this.haloGlow, x - g, y - g, g * 2, g * 2);
			ctx.globalAlpha = Math.min(1, 0.22 * glow);
			g = R * 8;
			ctx.drawImage(this.haloGlow, x - g, y - g, g * 2, g * 2);
		}

		// Far half of the disk
		this.drawDiskBand(false);
		this.drawDiskParticles(false);

		// Light from the far side of the disk, bent up and over the hole by gravity.
		const lens = (0.3 + 0.7 * this.fst) * Math.max(0.4, glow);
		const halo = ctx.createRadialGradient(x, y, R * 1.02, x, y, R * 2.1);
		halo.addColorStop(0, rgba(mix(this.diskColor, [255, 255, 255], 0.4), 0.55 * lens));
		halo.addColorStop(0.25, rgba(this.diskColor, 0.22 * lens));
		halo.addColorStop(1, rgba(this.diskColor, 0));
		ctx.fillStyle = halo;
		ctx.beginPath();
		ctx.arc(x, y, R * 2.1, 0, TAU);
		ctx.fill();
		// Brighter over the top: same glow, centered a little above the hole.
		const ay = y - R * 0.35;
		const arc = ctx.createRadialGradient(x, ay, R * 0.9, x, ay, R * 1.85);
		arc.addColorStop(0, rgba(mix(this.diskColor, [255, 255, 255], 0.3), 0.42 * lens));
		arc.addColorStop(0.4, rgba(this.diskColor, 0.14 * lens));
		arc.addColorStop(1, rgba(this.diskColor, 0));
		ctx.fillStyle = arc;
		ctx.beginPath();
		ctx.arc(x, ay, R * 1.85, 0, TAU);
		ctx.fill();

		// Event horizon
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
		const core = ctx.createRadialGradient(x, y, 0, x, y, R * 1.08);
		core.addColorStop(0, "#000");
		core.addColorStop(0.93, "#000");
		core.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = core;
		ctx.beginPath();
		ctx.arc(x, y, R * 1.08, 0, TAU);
		ctx.fill();

		// Photon ring
		ctx.globalCompositeOperation = "lighter";
		ctx.beginPath();
		ctx.arc(x, y, R * 1.02, 0, TAU);
		ctx.strokeStyle = rgba(this.diskColor, 0.12);
		ctx.lineWidth = Math.max(2, R * 0.22);
		ctx.stroke();
		ctx.strokeStyle = rgba(mix(this.diskColor, [255, 255, 255], 0.7), 0.75);
		ctx.lineWidth = Math.max(0.6, Math.min(1.4, R * 0.03));
		ctx.stroke();

		// Near half of the disk, in front of the hole (drawn after bloom when bloom is on)
		if (!this.bloomActive()) this.drawDiskBand(true);
		this.drawDiskParticles(true);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private drawLabels(): void {
		const ctx = this.ctx;
		const layout = this.layout;
		if (!layout) return;
		const threshold = this.settings.labelThreshold;
		const hl = this.highlight;
		const textColor = rgba(mix(this.accent, [255, 255, 255], 0.6), 1);
		const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
		const spacing = (v: string) => {
			if ("letterSpacing" in c) c.letterSpacing = v;
		};
		const placed: Array<[number, number, number, number]> = [];
		const free = (r: [number, number, number, number]) => {
			for (const q of placed) {
				if (r[0] < q[0] + q[2] && r[0] + r[2] > q[0] && r[1] < q[1] + q[3] && r[1] + r[3] > q[1]) return false;
			}
			return true;
		};

		// Center title, under the disk
		const center = this.bodies[layout.center];
		if (center) {
			const y = this.h - 54;
			const name = center.name.length > 40 ? center.name.slice(0, 39) + "…" : center.name;
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			ctx.font = `500 11px ${this.fontFamily}`;
			spacing("0.22em");
			ctx.globalAlpha = 0.85;
			ctx.fillStyle = textColor;
			const title = name.toUpperCase();
			ctx.fillText(title, this.w / 2, y);
			const tw = ctx.measureText(title).width;
			ctx.font = `400 9.5px ${this.monoFamily}`;
			spacing("0.12em");
			ctx.globalAlpha = 0.36;
			const sub = `${this.reachable} IN ORBIT · ${center.degree} DIRECT`;
			ctx.fillText(sub, this.w / 2, y + 17);
			// Hairlines either side of the title
			ctx.globalAlpha = 0.25;
			ctx.fillRect(this.w / 2 - tw / 2 - 34, y + 6, 22, 1);
			ctx.fillRect(this.w / 2 + tw / 2 + 12, y + 6, 22, 1);
			placed.push([this.w / 2 - tw / 2 - 40, y - 4, tw + 80, 36]);
		}

		// Hovered note: annotation with a leader line, like a star chart.
		if (this.hovered >= 0) {
			const b = this.bodies[this.hovered];
			if (this.hovered === layout.center) {
				b.sx = this.fcx;
				b.sy = this.fcy;
				b.rad = HOLE_R * this.fzoom;
			}
			const right = b.sx < this.w - 220;
			const dir = right ? 1 : -1;
			const ex = b.sx + dir * 26;
			const ey = b.sy - 26;
			ctx.globalAlpha = 0.6;
			ctx.strokeStyle = textColor;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(b.sx + dir * (b.rad * 1.5 + 6) * 0.7, b.sy - (b.rad * 1.5 + 6) * 0.7);
			ctx.lineTo(ex, ey);
			ctx.font = `400 13px ${this.fontFamily}`;
			spacing("0.01em");
			const name = b.name.length > 44 ? b.name.slice(0, 43) + "…" : b.name;
			const tw = ctx.measureText(name).width;
			ctx.lineTo(ex + dir * (tw + 8), ey);
			ctx.stroke();
			ctx.textAlign = right ? "left" : "right";
			ctx.textBaseline = "bottom";
			ctx.globalAlpha = 0.95;
			ctx.fillStyle = textColor;
			ctx.fillText(name, ex + dir * 4, ey - 4);
			ctx.textBaseline = "top";
			ctx.font = `400 9.5px ${this.monoFamily}`;
			spacing("0.12em");
			ctx.globalAlpha = 0.42;
			const orbit = b.ring === -1 ? "OUTER RING" : b.ring === 0 ? "CENTER" : `ORBIT ${b.ring}`;
			ctx.fillText(`${b.degree} LINK${b.degree === 1 ? "" : "S"} · ${orbit}`, ex + dir * 4, ey + 5);
			const x0 = right ? ex : ex - tw - 12;
			placed.push([x0, ey - 22, tw + 12, 40]);
		}

		const cands: Array<{ b: Body; p: number }> = [];
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (i === layout.center || i === this.hovered) continue;
			if (b.hidden || b.alpha < 0.3) continue;
			if (b.sx < -50 || b.sy < -20 || b.sx > this.w + 50 || b.sy > this.h + 30) continue;
			let p = 0;
			if (this.hovered >= 0) p = this.hoverNeighbors.has(i) ? 100 + b.rad : 0;
			else if (hl) p = hl.has(b.id) ? 100 + b.rad : 0;
			else if (threshold === 0 || b.rad >= threshold) p = b.rad;
			if (p > 0) cands.push({ b, p });
		}
		cands.sort((a, b) => b.p - a.p);
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		ctx.font = `400 10.5px ${this.fontFamily}`;
		spacing("0.03em");
		ctx.fillStyle = textColor;
		let count = 0;
		for (const { b, p } of cands) {
			if (count > 140) break;
			const text = b.name.length > 30 ? b.name.slice(0, 29) + "…" : b.name;
			const tw = ctx.measureText(text).width;
			const y = b.sy + b.rad + 7;
			const rect: [number, number, number, number] = [b.sx - tw / 2 - 10, y - 5, tw + 20, 22];
			if (!free(rect)) continue;
			placed.push(rect);
			count++;
			const fadeIn = threshold > 0 && p < 100 ? clamp((b.rad - threshold + 1) / 2, 0, 1) : 1;
			ctx.globalAlpha = b.alpha * fadeIn * (p >= 100 ? 0.65 : 0.42);
			ctx.fillText(text, b.sx, y);
		}
		spacing("0px");
		ctx.globalAlpha = 1;
	}
}
