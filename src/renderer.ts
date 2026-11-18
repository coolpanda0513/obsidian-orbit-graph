import { computeLayout, findHub, GraphData, hash01, OrbitLayout } from "./graph";
import { hexToRgb, mix, rgba } from "./palette";
import type { OrbitSettings } from "./types";

/**
 * Canvas 2D renderer for the orbit graph. Independent of Obsidian: it takes a
 * graph + settings and reports interactions through callbacks.
 *
 * Every note is a point of light on a circular orbit around the center note.
 * The orbit plane is tilted towards the viewer with a mild perspective.
 * Visual language: near-black space, a single light color, hairline orbits.
 */

export interface RendererCallbacks {
	onHover?(id: string | null, ev: MouseEvent | null): void;
	onClick?(id: string, ev: MouseEvent): void;
	onContextMenu?(id: string, ev: MouseEvent): void;
}

export interface RendererOptions {
	fontFamily?: string;
}

type RGB = [number, number, number];

interface Body {
	id: string;
	name: string;
	r: number;
	targetR: number;
	angle: number;
	slot: number;
	/** 0 = center, 1..n = orbit, -1 = outer belt. */
	ring: number;
	hidden: boolean;
	size: number;
	degree: number;
	alpha: number;
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
}

interface Signal {
	edge: number;
	t: number;
	speed: number;
	reverse: boolean;
}

const TAU = Math.PI * 2;
const FIRST_ORBIT = 150;
const ORBIT_GAP = 95;
const SLOT_SPACING = 22;
const LANE_SPACING = 12;
const SUN_SIZE = 6;

function angleDiff(target: number, current: number): number {
	let d = (target - current) % TAU;
	if (d > Math.PI) d -= TAU;
	if (d < -Math.PI) d += TAU;
	return d;
}

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
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

function glowSprite(rgb: RGB, falloff: number): HTMLCanvasElement {
	const S = 128;
	const c = document.createElement("canvas");
	c.width = c.height = S;
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

	private w = 0;
	private h = 0;
	private dpr = 1;

	private graph: GraphData | null = null;
	private layout: OrbitLayout | null = null;
	private centerId: string | null = null;
	private bodies: Body[] = [];
	private bodyById = new Map<string, Body>();

	private ringRadius: number[] = [];
	private ringLanes: number[] = [];
	private ringAngle: number[] = [];
	private beltR = 0;
	private beltW = 0;
	private beltAngle = 0;
	private outerR = 300;

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

	private accent: RGB = [255, 255, 255];
	private glow!: HTMLCanvasElement;
	private sunGlow!: HTMLCanvasElement;
	private stars: Star[] = [];
	private signals: Signal[] = [];

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
		this.setAccent(settings.accentColor);

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
		const refit = center !== undefined && center !== this.centerId;
		if (center !== undefined) this.centerId = center;
		this.graph = graph;
		const old = this.bodyById;
		const bodies: Body[] = [];
		const byId = new Map<string, Body>();
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
			b.size = Math.min(5.5, 1.6 + Math.sqrt(node.degree) * 0.8);
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

	setHighlight(ids: Set<string> | null): void {
		this.highlight = ids;
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
		if (prev.accentColor !== settings.accentColor) this.setAccent(settings.accentColor);
	}

	fit(immediate = false): void {
		if (!this.w || !this.h) return;
		const outer = Math.max(this.outerR, FIRST_ORBIT);
		const F = this.focal();
		const ct = Math.cos(this.tTilt);
		const st = Math.sin(this.tTilt);
		const sNear = F / (F - outer * st);
		const zx = (this.w * 0.44) / outer;
		const zy = (this.h * 0.42) / Math.max(outer * ct * sNear, outer * 0.25);
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

	private setAccent(hex: string): void {
		const rgb = /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex || "") ? hexToRgb(hex) : null;
		this.accent = rgb || [255, 255, 255];
		this.glow = glowSprite(this.accent, 1);
		this.sunGlow = glowSprite(mix(this.accent, [255, 255, 255], 0.3), 0.8);
	}

	private focal(): number {
		return Math.max(2200, this.outerR * 5);
	}

	private relayout(refit = false): void {
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
				const jitter = k === 0 ? 0 : (hash01(b.id, 7) - 0.5) * 4;
				b.targetR = radii[k] + lane * LANE_SPACING + jitter;
			}
		}

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
				b.r = b.targetR * 0.04;
				b.angle = this.targetAngle(b) - 1.6 - hash01(b.id, 3);
			} else {
				b.r = b.targetR + 120;
				b.angle = this.targetAngle(b);
			}
			b.alpha = 0;
		}

		this.resetSignals();

		if (this.firstLayout && this.w) {
			this.firstLayout = false;
			this.fit(true);
			this.zoom = this.tZoom * 1.6;
		} else if (refit && !this.firstLayout) {
			this.fit();
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

	private resetSignals(): void {
		this.signals = [];
		const edges = this.graph?.edges.length || 0;
		if (!this.settings.showSignals || !edges) return;
		const n = Math.min(14, Math.ceil(edges / 6));
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
		s.t = 0;
		s.speed = 0.12 + Math.random() * 0.18;
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
		this.generateStars();
		if (this.firstLayout && this.layout) {
			this.firstLayout = false;
			this.fit(true);
			this.zoom = this.tZoom * 1.6;
		}
	}

	private generateStars(): void {
		const rand = mulberry32(42);
		const count = Math.round(((this.w * this.h) / 4500) * this.settings.starDensity);
		this.stars = [];
		for (let i = 0; i < count; i++) {
			this.stars.push({
				x: rand() * this.w,
				y: rand() * this.h,
				r: 0.4 + Math.pow(rand(), 3) * 0.8,
				layer: 0.005 + rand() * 0.04,
				phase: rand() * TAU,
				speed: 0.15 + rand() * 0.5,
				bright: 0.08 + Math.pow(rand(), 2) * 0.4,
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
		this.callbacks.onHover?.(idx >= 0 ? this.bodies[idx].id : null, ev);
	}

	private hitTest(x: number, y: number): number {
		if (!this.layout) return -1;
		let best = -1;
		let bestZ = -Infinity;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (b.hidden || b.alpha < 0.05) continue;
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

		const ease = 1 - Math.exp(-dt * 1.8);
		const fade = 1 - Math.exp(-dt * 5);
		const hovering = this.hovered >= 0;
		const hl = this.highlight;
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			b.r += (b.targetR - b.r) * ease;
			b.angle += angleDiff(this.targetAngle(b), b.angle) * ease;
			let ta = b.hidden ? 0 : b.ring === -1 ? 0.45 : 1;
			if (!b.hidden) {
				if (hovering) ta = i === this.hovered || this.hoverNeighbors.has(i) ? 1 : 0.2;
				else if (hl) ta = hl.has(b.id) ? 1 : 0.15;
			}
			b.alpha += (ta - b.alpha) * fade;
		}

		const cam = 1 - Math.exp(-dt * 6);
		this.zoom += (this.tZoom - this.zoom) * cam;
		this.panX += (this.tPanX - this.panX) * cam;
		this.panY += (this.tPanY - this.panY) * cam;
		this.tilt += (this.tTilt - this.tilt) * cam;

		for (const s of this.signals) {
			s.t += dt * s.speed;
			if (s.t >= 1) this.spawnSignal(s);
		}
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
			const size = b.ring === 0 ? SUN_SIZE : b.ring === -1 ? b.size * 0.7 : b.size;
			b.rad = Math.max(0.9, size * s * Math.sqrt(zoom));
		}
		const sun = this.bodies[layout.center];
		this.sunX = sun ? sun.sx : cx;
		this.sunY = sun ? sun.sy : cy;

		if (this.settings.showOrbits) this.drawOrbits(cx, cy, ct, st, F);
		if (this.settings.showLinks) this.drawLinks();
		if (this.settings.showSignals && this.settings.showLinks) this.drawSignals();

		const order = this.order;
		order.length = 0;
		for (let i = 0; i < this.bodies.length; i++) {
			if (!this.bodies[i].hidden || this.bodies[i].alpha > 0.01) order.push(i);
		}
		order.sort((a, b) => this.bodies[a].sz - this.bodies[b].sz);
		ctx.globalCompositeOperation = "lighter";
		for (const i of order) {
			if (i === layout.center) this.drawSun(this.bodies[i]);
			else this.drawBody(this.bodies[i], i === this.hovered);
		}
		ctx.globalCompositeOperation = "source-over";

		this.drawLabels();
		ctx.globalAlpha = 1;
	}

	private drawBackground(): void {
		const ctx = this.ctx;
		const { w, h } = this;
		ctx.fillStyle = "#040405";
		ctx.fillRect(0, 0, w, h);
		// A barely-there lift of light around the center of the system.
		const x = w / 2 + this.panX;
		const y = h / 2 + this.panY;
		const grad = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h) * 0.7);
		grad.addColorStop(0, rgba(this.accent, 0.035));
		grad.addColorStop(1, rgba(this.accent, 0));
		ctx.fillStyle = grad;
		ctx.fillRect(0, 0, w, h);

		if (!this.stars.length) return;
		const t = this.time;
		ctx.fillStyle = "#ffffff";
		for (const s of this.stars) {
			let sx = (s.x + this.panX * s.layer) % w;
			let sy = (s.y + this.panY * s.layer) % h;
			if (sx < 0) sx += w;
			if (sy < 0) sy += h;
			ctx.globalAlpha = s.bright * (0.7 + 0.3 * Math.sin(t * s.speed + s.phase));
			ctx.fillRect(sx, sy, s.r, s.r);
		}
		ctx.globalAlpha = 1;
	}

	private orbitPath(r: number, cx: number, cy: number, ct: number, st: number, F: number): void {
		const ctx = this.ctx;
		const zoom = this.zoom;
		const steps = 200;
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
		const dim = this.hovered >= 0 || this.highlight ? 0.5 : 1;
		ctx.lineWidth = 1;
		for (let k = 1; k < this.ringRadius.length; k++) {
			const band = (this.ringLanes[k] - 1) * LANE_SPACING;
			this.orbitPath(this.ringRadius[k] + band / 2, cx, cy, ct, st, F);
			ctx.strokeStyle = rgba(this.accent, 0.085 * dim);
			ctx.stroke();
		}
		if (this.beltW > 0) {
			ctx.setLineDash([1, 5]);
			this.orbitPath(this.beltR + this.beltW / 2, cx, cy, ct, st, F);
			ctx.strokeStyle = rgba(this.accent, 0.07 * dim);
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	private controlPoint(a: Body, b: Body): [number, number] {
		const mx = (a.sx + b.sx) / 2;
		const my = (a.sy + b.sy) / 2;
		return [mx + (this.sunX - mx) * 0.12, my + (this.sunY - my) * 0.12];
	}

	private drawLinks(): void {
		const ctx = this.ctx;
		const graph = this.graph;
		if (!graph) return;
		const bodies = this.bodies;
		const focus = this.hovered >= 0 || this.highlight !== null;
		const base = this.settings.linkOpacity * (focus ? 0.3 : 1);
		ctx.lineWidth = 1;
		if (base > 0.001) {
			ctx.strokeStyle = rgba(this.accent, 0.11 * base);
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
			ctx.strokeStyle = rgba(this.accent, 0.4);
			ctx.stroke();
		}
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
			ctx.globalAlpha = Math.sin(Math.PI * t) * 0.5 * Math.min(a.alpha, b.alpha);
			const g = 4;
			ctx.drawImage(this.glow, x - g, y - g, g * 2, g * 2);
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	private drawBody(b: Body, hovered: boolean): void {
		const ctx = this.ctx;
		// The far side of the orbit plane is slightly dimmer than the near side.
		const depth = clamp(0.65 + (b.ss - 1) * 2.5, 0.45, 1);
		const alpha = b.alpha * depth;
		if (alpha < 0.01) return;
		const rad = b.rad * (hovered ? 1.4 : 1);
		const glow = this.settings.glowIntensity;

		if (glow > 0) {
			ctx.globalAlpha = Math.min(1, alpha * 0.4 * glow * (hovered ? 1.8 : 1));
			const g = rad * 8 + 4;
			ctx.drawImage(this.glow, b.sx - g, b.sy - g, g * 2, g * 2);
		}
		ctx.globalAlpha = alpha * 0.85;
		ctx.fillStyle = rgba(mix(this.accent, [255, 255, 255], 0.55), 1);
		ctx.beginPath();
		ctx.arc(b.sx, b.sy, rad, 0, TAU);
		ctx.fill();
	}

	private drawSun(b: Body): void {
		const ctx = this.ctx;
		const breathe = 1 + 0.05 * Math.sin(this.time * 0.9);
		const R = b.rad;
		const glow = this.settings.glowIntensity;
		const a = Math.max(b.alpha, 0.4);
		if (glow > 0) {
			ctx.globalAlpha = Math.min(1, 0.22 * glow * a);
			let g = R * 44 * breathe;
			ctx.drawImage(this.sunGlow, b.sx - g, b.sy - g, g * 2, g * 2);
			ctx.globalAlpha = Math.min(1, 0.55 * glow * a);
			g = R * 9 * breathe;
			ctx.drawImage(this.sunGlow, b.sx - g, b.sy - g, g * 2, g * 2);
		}
		ctx.globalAlpha = a;
		ctx.fillStyle = "#ffffff";
		ctx.beginPath();
		ctx.arc(b.sx, b.sy, R, 0, TAU);
		ctx.fill();
		ctx.globalAlpha = 1;
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
			else if (hl) p = hl.has(b.id) ? 100 + b.rad : 0;
			else if (threshold === 0 || b.rad >= threshold) p = b.rad;
			if (p > 0) cands.push({ b, p });
		}
		cands.sort((a, b) => b.p - a.p);
		const placed: Array<[number, number, number, number]> = [];
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
		const textColor = rgba(mix(this.accent, [255, 255, 255], 0.6), 1);
		for (let k = 0; k < cands.length && placed.length < 160; k++) {
			const { b, p } = cands[k];
			const isSun = p === 1000;
			const isHover = p === 900;
			const fs = isSun ? 11 : isHover ? 12 : 10.5;
			ctx.font = `${isSun ? 500 : 400} ${fs}px ${this.fontFamily}`;
			if ("letterSpacing" in c) c.letterSpacing = isSun ? "0.14em" : "0.02em";
			let text = b.name.length > 34 ? b.name.slice(0, 33) + "…" : b.name;
			if (isSun) text = text.toUpperCase();
			const tw = ctx.measureText(text).width;
			const x = b.sx;
			const y = b.sy + (isSun ? b.rad + 16 : b.rad + 7);
			const rect: [number, number, number, number] = [x - tw / 2 - 10, y - 5, tw + 20, fs + 12];
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
			const fadeIn = threshold > 0 && p < 100 ? clamp((b.rad - threshold + 1) / 2, 0, 1) : 1;
			const strength = isHover ? 0.95 : isSun ? 0.75 : p >= 100 ? 0.6 : 0.4;
			ctx.globalAlpha = b.alpha * fadeIn * strength;
			ctx.fillStyle = textColor;
			ctx.fillText(text, x, y);
			if (isHover) {
				ctx.font = `400 10px ${this.fontFamily}`;
				ctx.globalAlpha = 0.4;
				ctx.fillText(`${b.degree} link${b.degree === 1 ? "" : "s"}`, x, y + fs + 4);
			}
		}
		if ("letterSpacing" in c) c.letterSpacing = "0px";
		ctx.globalAlpha = 1;
	}
}
