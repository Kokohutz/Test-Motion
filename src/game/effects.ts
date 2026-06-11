/**
 * Reward visual effects: a glowing particle trail that follows the
 * reference dancer's most active joint while the player scores well.
 *
 * Canvas-2D re-implementation of the legacy p5.js/WebGL "magical trail"
 * shader (visual_effects/), so the game has no p5/CDN dependency. The
 * layer uses additive composition + the container's mix-blend-mode to get
 * a similar neon look.
 */

const COLOR_SCHEME = ['#E69F66', '#DF843A', '#D8690F', '#B1560D', '#8A430A'];
const MAX_PARTICLES = 70;
const MAX_TRAIL = 30;

export interface EffectsInput {
    enabled: boolean;
    active: boolean;
    /** 0..1 intensity (accuracy + combo boost). */
    strength: number;
    /** Normalized 0..1 position of the tracked joint. */
    x: number;
    y: number;
    hasInput: boolean;
}

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    mass: number;
    drag: number;
    color: string;
}

export class EffectsEngine {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D | null;
    private rafId: number | null = null;
    private trail: [number, number][] = [];
    private particles: Particle[] = [];
    private lastX: number | null = null;
    private lastY: number | null = null;
    private state: EffectsInput = { enabled: false, active: false, strength: 0, x: 0.5, y: 0.5, hasInput: false };

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    setState(partial: Partial<EffectsInput>): void {
        this.state = { ...this.state, ...partial };
    }

    resize(width: number, height: number): void {
        this.canvas.width = Math.max(1, Math.round(width));
        this.canvas.height = Math.max(1, Math.round(height));
    }

    start(): void {
        if (this.rafId !== null) return;
        const loop = () => {
            this.tick();
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    stop(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.trail = [];
        this.particles = [];
        this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    private tick(): void {
        const ctx = this.ctx;
        if (!ctx) return;

        const { enabled, strength } = this.state;
        const active = enabled && this.state.active && strength > 0.01;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (!enabled) {
            this.trail = [];
            this.particles = [];
            return;
        }

        const width = this.canvas.width;
        const height = this.canvas.height;
        const inputX = this.state.hasInput ? this.state.x * width : width / 2;
        const inputY = this.state.hasInput ? this.state.y * height : height / 2;
        const prevX = this.lastX ?? inputX;
        const prevY = this.lastY ?? inputY;
        this.lastX = inputX;
        this.lastY = inputY;

        const trailLimit = Math.max(6, Math.round(MAX_TRAIL * (0.3 + 0.7 * strength)));
        const maxParticles = Math.max(10, Math.round(MAX_PARTICLES * (0.4 + 0.6 * strength)));

        if (active && this.state.hasInput) {
            this.trail.push([inputX, inputY]);
            while (this.trail.length > trailLimit) this.trail.shift();

            const dx = inputX - prevX;
            const dy = inputY - prevY;
            const dist = Math.hypot(dx, dy);
            const spawnThreshold = 6 + (1 - strength) * 10;
            if (this.trail.length > 1 && this.particles.length < maxParticles && dist > spawnThreshold) {
                const boost = (1 + strength * 0.6) * (1 + Math.random() * 9);
                const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.9;
                this.particles.push({
                    x: prevX,
                    y: prevY,
                    vx: Math.cos(angle) * boost,
                    vy: Math.sin(angle) * boost,
                    mass: 1 + Math.random() * 19,
                    drag: 0.92 + Math.random() * 0.06,
                    color: COLOR_SCHEME[Math.floor(Math.random() * COLOR_SCHEME.length)]
                });
            }
        } else if (this.trail.length > 0) {
            this.trail.shift(); // decay the trail without new input
        }

        // Move and cull particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.vx *= p.drag;
            p.vy *= p.drag;
            p.x += p.vx;
            p.y += p.vy;
            if (Math.hypot(p.vx, p.vy) < 0.1) this.particles.splice(i, 1);
        }

        // Additive glow rendering
        ctx.globalCompositeOperation = 'lighter';

        for (let i = 0; i < this.trail.length; i++) {
            const [x, y] = this.trail[i];
            const t = (i + 1) / this.trail.length;
            const radius = 4 + 14 * t * (0.5 + 0.5 * strength);
            const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
            gradient.addColorStop(0, `rgba(0, 212, 255, ${0.35 * t})`);
            gradient.addColorStop(0.6, `rgba(0, 255, 136, ${0.18 * t})`);
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
        }

        for (const p of this.particles) {
            const speed = Math.hypot(p.vx, p.vy);
            const radius = Math.max(1.5, Math.min(12, p.mass * speed * 0.06));
            const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 2.2);
            gradient.addColorStop(0, p.color);
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.globalAlpha = Math.min(1, 0.25 + speed * 0.08);
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius * 2.2, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }
}
