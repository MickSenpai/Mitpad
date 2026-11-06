<script lang="ts">
    import { onMount } from 'svelte';
    import type { GraphLink, GraphNode, RelationType } from './graph';

    export let nodes: GraphNode[] = [];
    export let links: GraphLink[] = [];
    export let onSelect: (node: GraphNode) => void;

    type Projected = { node: GraphNode; x: number; y: number; scale: number; depth: number; alpha: number; radius: number };
    type Point = { x: number; y: number };

    const HOME = { yaw: -0.55, pitch: 0.22 };
    const ZOOM_MIN = 0.55, ZOOM_MAX = 2.4;
    const APPEAR_MS = 650;

    // Same warm palette as the rest of the app (olive, sage, sand, terracotta).
    const PALETTE = {
        project: { fill: '#3a4029', stroke: '#b3bd8f', glow: '179,189,143', label: '#f2eee3' },
        task: { fill: '#3a3426', stroke: '#c4b184', glow: '196,177,132', label: '#d6d1c0' },
        done: { fill: '#2f3623', stroke: '#7f8f63', glow: '127,143,99', label: '#aeb39c' },
        blocked: { fill: '#43261f', stroke: '#e5816b', glow: '229,129,107', label: '#f0b3a5' },
        knowledge: { fill: '#43312a', stroke: '#dfa284', glow: '223,162,132', label: '#e8cdbb' },
    };
    const RELATION: Record<RelationType, { rgb: string; dash: number[]; arrow: boolean }> = {
        related_to: { rgb: '194,151,114', dash: [5, 5], arrow: false },
        parent_of: { rgb: '179,189,143', dash: [], arrow: true },
        depends_on: { rgb: '223,162,132', dash: [2, 5], arrow: true },
    };

    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D | null = null;
    let width = 900, height = 560, dpr = 1;

    // Camera. `zoom` chases `zoomTarget`; yaw/pitch keep their velocity after release (inertia).
    let yaw = HOME.yaw, pitch = HOME.pitch, yawV = 0, pitchV = 0;
    let zoom = 1, zoomTarget = 1, panX = 0, panY = 0;
    let anchor: { x: number; y: number; panX: number; panY: number; zoom: number } | null = null;
    let resetting = false;

    let reducedMotion = false, onScreen = true;
    let raf = 0, lastTime = 0, lastDraw = 0;
    let projected: Projected[] = [];
    let extent = 250;
    let nodeById = new Map<string, GraphNode>();
    let adjacency = new Map<string, Set<string>>();
    const born = new Map<string, number>();

    let hoveredNodeId = '', focusId = '', hoverStrength = 0, selectedId = '';
    let tooltip: { node: GraphNode; x: number; y: number } | null = null;

    const pointers = new Map<number, Point>();
    let gesture: { mode: 'orbit' | 'pan' | 'pinch'; moved: number; lastT: number; lastDist: number; lastMid: Point } | null = null;

    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    $: syncGraph(nodes, links);

    function syncGraph(ns: GraphNode[], ls: GraphLink[]) {
        nodeById = new Map(ns.map((n) => [n.id, n]));
        const next = new Map<string, Set<string>>();
        const connect = (a: string, b: string) => {
            if (!next.has(a)) next.set(a, new Set());
            if (!next.has(b)) next.set(b, new Set());
            next.get(a)!.add(b); next.get(b)!.add(a);
        };
        for (const n of ns) if (n.kind !== 'project') connect(n.id, n.projectId);
        for (const l of ls) connect(l.source_project_id, l.target_project_id);
        adjacency = next;
        extent = Math.max(250, ...ns.map((n) => Math.hypot(n.x, n.y, n.z)));
        // Nodes that were already on screen stay put; new ones grow out of their project, staggered.
        for (const id of [...born.keys()]) if (!nodeById.has(id)) born.delete(id);
        const now = performance.now();
        let fresh = 0;
        for (const n of ns) if (!born.has(n.id)) born.set(n.id, reducedMotion ? -1e9 : now + fresh++ * 16);
        wake();
    }

    onMount(() => {
        const motion = matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotion = motion.matches;
        const onMotion = () => { reducedMotion = motion.matches; wake(); };
        motion.addEventListener('change', onMotion);

        const resize = new ResizeObserver(() => {
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            width = rect.width; height = rect.height;
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
            ctx = canvas.getContext('2d');
            wake(); draw(performance.now());
        });
        resize.observe(canvas);
        const visibility = new IntersectionObserver((entries) => { onScreen = entries.some((e) => e.isIntersecting); if (onScreen) wake(); });
        visibility.observe(canvas);
        return () => { cancelAnimationFrame(raf); raf = 0; resize.disconnect(); visibility.disconnect(); motion.removeEventListener('change', onMotion); };
    });

    // ── animation loop ────────────────────────────────────────────────────────
    // Runs only while something moves; when idle it drops to ~30fps for the gentle float.
    const floating = () => !reducedMotion && onScreen && nodes.length > 0;

    function wake() { if (!raf && ctx) raf = requestAnimationFrame(frame); }

    function frame(now: number) {
        raf = 0;
        const dt = Math.min(0.05, (now - (lastTime || now)) / 1000);
        lastTime = now;
        const active = step(dt, now);
        if (!active && now - lastDraw < 33) { raf = requestAnimationFrame(frame); return; }
        lastDraw = now;
        draw(now);
        if (active || floating()) raf = requestAnimationFrame(frame);
        else lastTime = 0;
    }

    function step(dt: number, now: number): boolean {
        let active = false;
        const ease = reducedMotion ? 1 : 1 - Math.exp(-dt * 12);

        if (!gesture && (Math.abs(yawV) > 0.01 || Math.abs(pitchV) > 0.01)) {
            yaw += yawV * dt; pitch = clamp(pitch + pitchV * dt, -1.1, 1.1);
            const damping = Math.exp(-dt * 4.5);
            yawV *= damping; pitchV *= damping;
            if (Math.abs(yawV) <= 0.01) yawV = 0;
            if (Math.abs(pitchV) <= 0.01) pitchV = 0;
            active = true;
        }
        if (resetting) {
            const a = reducedMotion ? 1 : 1 - Math.exp(-dt * 9);
            yaw = HOME.yaw + wrap(yaw - HOME.yaw) * (1 - a); pitch += (HOME.pitch - pitch) * a;
            panX += -panX * a; panY += -panY * a;
            const settled = Math.abs(yaw - HOME.yaw) < 0.002 && Math.abs(pitch - HOME.pitch) < 0.002 && Math.abs(panX) < 0.5 && Math.abs(panY) < 0.5 && Math.abs(zoom - zoomTarget) < 0.002;
            if (settled) { yaw = HOME.yaw; pitch = HOME.pitch; panX = panY = 0; zoom = zoomTarget; resetting = false; }
            else active = true;
        }
        if (Math.abs(zoomTarget - zoom) > 0.0005) {
            zoom += (zoomTarget - zoom) * ease;
            if (anchor) { panX = anchor.x - (anchor.x - anchor.panX) * (zoom / anchor.zoom); panY = anchor.y - (anchor.y - anchor.panY) * (zoom / anchor.zoom); }
            active = true;
        } else if (zoom !== zoomTarget) { zoom = zoomTarget; anchor = null; }
        const limit = Math.max(width, height) * 0.8;
        panX = clamp(panX, -limit, limit); panY = clamp(panY, -limit, limit);

        const wanted = hoveredNodeId ? 1 : 0;
        if (Math.abs(wanted - hoverStrength) > 0.01) { hoverStrength += (wanted - hoverStrength) * (reducedMotion ? 1 : 1 - Math.exp(-dt * 10)); active = true; }
        else hoverStrength = wanted;

        if (!reducedMotion) for (const b of born.values()) if (now - b < APPEAR_MS) { active = true; break; }
        return active;
    }

    const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

    // ── drawing ───────────────────────────────────────────────────────────────
    function paletteFor(node: GraphNode) {
        if (node.kind === 'project') return PALETTE.project;
        if (node.kind === 'knowledge') return PALETTE.knowledge;
        return node.status === 'blocked' ? PALETTE.blocked : node.status === 'done' ? PALETTE.done : PALETTE.task;
    }

    function draw(now: number) {
        if (!ctx || !width) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const cx = width / 2 + panX, cy = height / 2 + panY;
        const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosP = Math.cos(pitch), sinP = Math.sin(pitch);
        const camera = extent * 3.2;
        const fit = Math.min(1, Math.min(width * 0.44, height * 0.38) / extent) * zoom;
        const project = (x: number, y: number, z: number) => {
            const rx = x * cosY - z * sinY, rz = x * sinY + z * cosY;
            const ry = y * cosP - rz * sinP, depth = camera + y * sinP + rz * cosP;
            const scale = camera / Math.max(1, depth);
            // Far things fade a little so the orbit reads as depth rather than a flat layer.
            const fog = 1 - 0.5 * clamp((depth - (camera - extent)) / (2 * extent), 0, 1);
            return { x: cx + rx * scale * fit, y: cy + ry * scale * fit, scale, depth, fog };
        };

        const time = now / 1000;
        const sizeBoost = clamp(Math.sqrt(zoom), 0.85, 1.6);
        projected = nodes.map((node, i) => {
            const t = clamp((now - (born.get(node.id) ?? -1e9)) / APPEAR_MS, 0, 1);
            const e = 1 - Math.pow(1 - t, 3);
            const parent = node.kind === 'project' ? undefined : nodeById.get(node.projectId);
            const ox = parent?.x ?? 0, oy = parent?.y ?? 0, oz = parent?.z ?? 0;
            const bob = reducedMotion ? 0 : Math.sin(time * 0.9 + i * 1.7) * (node.kind === 'project' ? 1.5 : 3);
            const p = project(ox + (node.x - ox) * e, oy + (node.y - oy) * e + bob, oz + (node.z - oz) * e);
            const base = node.kind === 'project' ? 18 : node.kind === 'knowledge' ? 8 : 10;
            return { node, x: p.x, y: p.y, scale: p.scale, depth: p.depth, alpha: e * p.fog, radius: base * clamp(p.scale, 0.68, 1.5) * sizeBoost };
        });
        const byId = new Map(projected.map((p) => [p.node.id, p]));

        // Floor grid anchors the depth and makes the orbit controls legible.
        ctx.lineWidth = 1;
        for (let i = -4; i <= 4; i++) {
            const gx = i * extent / 4, y = extent * 0.42;
            const lines = [[project(gx, y, -extent), project(gx, y, extent)], [project(-extent, y, gx), project(extent, y, gx)]];
            for (const [a, b] of lines) {
                ctx.strokeStyle = `rgba(184,181,167,${0.07 * ((a.fog + b.fog) / 2)})`;
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
        }

        const focus = hoverStrength > 0.01 ? focusId : '';
        const focusSet = focus ? new Set([focus, ...(adjacency.get(focus) ?? [])]) : null;
        const nodeDim = (id: string) => (focusSet && !focusSet.has(id) ? 1 - 0.75 * hoverStrength : 1);
        const edgeDim = (a: string, b: string) => (!focus ? 1 : a === focus || b === focus ? 1 : 1 - 0.85 * hoverStrength);
        const edgeBoost = (a: string, b: string) => (focus && (a === focus || b === focus) ? 1 + 0.7 * hoverStrength : 1);

        for (const node of nodes) {
            if (node.kind === 'project') continue;
            const from = byId.get(node.projectId), to = byId.get(node.id);
            if (!from || !to) continue;
            const alpha = (node.kind === 'knowledge' ? 0.34 : 0.3) * Math.min(from.alpha, to.alpha) * edgeDim(from.node.id, to.node.id);
            const lw = 1.4 * clamp((from.scale + to.scale) / 2, 0.7, 1.4) * edgeBoost(from.node.id, to.node.id);
            strokeEdge(from, to, node.kind === 'knowledge' ? '223,162,132' : '196,177,132', alpha, lw, [], false, 0);
        }
        for (const link of links) {
            const from = byId.get(link.source_project_id), to = byId.get(link.target_project_id);
            if (!from || !to) continue;
            const style = RELATION[link.relation_type ?? 'related_to'];
            const alpha = 0.8 * Math.min(from.alpha, to.alpha) * edgeDim(from.node.id, to.node.id);
            const lw = 1.6 * clamp((from.scale + to.scale) / 2, 0.7, 1.4) * edgeBoost(from.node.id, to.node.id);
            // A slight bend keeps A→B and B→A from drawing on top of each other.
            strokeEdge(from, to, style.rgb, alpha, lw, style.dash, style.arrow, 0.1, to.radius);
        }

        const ordered = [...projected].sort((a, b) => b.depth - a.depth);
        for (const p of ordered) {
            const { node, x, y, radius } = p;
            if (p.alpha < 0.02) continue;
            const pal = paletteFor(node);
            const hot = node.id === focus || node.id === selectedId;
            ctx.globalAlpha = p.alpha * nodeDim(node.id);
            const glowR = radius * (hot ? 3.2 : 2.5);
            const glow = ctx.createRadialGradient(x, y, radius * 0.6, x, y, glowR);
            glow.addColorStop(0, `rgba(${pal.glow},${hot ? 0.38 : 0.2})`); glow.addColorStop(1, `rgba(${pal.glow},0)`);
            ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, glowR, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = pal.fill; ctx.fill();
            ctx.strokeStyle = pal.stroke; ctx.lineWidth = node.kind === 'project' ? 2 : 1.4; ctx.stroke();
            if (node.id === selectedId) { ctx.beginPath(); ctx.arc(x, y, radius + 5, 0, Math.PI * 2); ctx.strokeStyle = '#f2eee3'; ctx.lineWidth = 1.5; ctx.stroke(); }
        }

        ctx.textAlign = 'center'; ctx.lineJoin = 'round';
        const showAll = zoomTarget >= 1.8;
        for (const p of ordered) {
            const { node, x, y, radius, scale } = p;
            const near = focusSet?.has(node.id) && hoverStrength > 0.4;
            if (p.alpha < 0.05 || !(node.kind === 'project' || node.id === selectedId || near || showAll)) continue;
            const label = node.label.length > 25 ? `${node.label.slice(0, 23)}…` : node.label;
            ctx.globalAlpha = p.alpha * nodeDim(node.id);
            ctx.font = `${node.kind === 'project' ? '600' : '400'} ${Math.max(10, 12 * Math.min(1.15, scale))}px Inter, system-ui, sans-serif`;
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(25,28,23,.85)'; ctx.strokeText(label, x, y + radius + 17);
            ctx.fillStyle = paletteFor(node).label; ctx.fillText(label, x, y + radius + 17);
        }
        ctx.globalAlpha = 1;
    }

    function strokeEdge(a: Projected, b: Projected, rgb: string, alpha: number, lineWidth: number, dash: number[], arrow: boolean, curve: number, trimEnd = 0) {
        if (!ctx || alpha < 0.01) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        if (Math.hypot(dx, dy) < 1) return;
        const control = curve ? { x: (a.x + b.x) / 2 - dy * curve, y: (a.y + b.y) / 2 + dx * curve } : null;
        const tx = control ? b.x - control.x : dx, ty = control ? b.y - control.y : dy, tl = Math.hypot(tx, ty) || 1;
        const ux = tx / tl, uy = ty / tl;
        const trim = arrow ? trimEnd + 4 : 0;
        const ex = b.x - ux * trim, ey = b.y - uy * trim;
        ctx.beginPath(); ctx.setLineDash(dash); ctx.lineWidth = lineWidth; ctx.strokeStyle = `rgba(${rgb},${alpha})`;
        ctx.moveTo(a.x, a.y);
        if (control) ctx.quadraticCurveTo(control.x, control.y, ex, ey); else ctx.lineTo(ex, ey);
        ctx.stroke(); ctx.setLineDash([]);
        if (arrow) {
            const s = Math.max(6, 8 * clamp(b.scale, 0.7, 1.4));
            ctx.beginPath(); ctx.moveTo(ex, ey);
            ctx.lineTo(ex - ux * s - uy * s * 0.5, ey - uy * s + ux * s * 0.5);
            ctx.lineTo(ex - ux * s + uy * s * 0.5, ey - uy * s - ux * s * 0.5);
            ctx.closePath(); ctx.fillStyle = `rgba(${rgb},${alpha})`; ctx.fill();
        }
    }

    // ── interaction ───────────────────────────────────────────────────────────
    function local(event: { clientX: number; clientY: number }): Point {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function hitTest(point: Point): Projected | undefined {
        let best: Projected | undefined, bestDistance = Infinity;
        for (const item of projected) {
            if (item.alpha < 0.3) continue;
            const distance = Math.hypot(item.x - point.x, item.y - point.y);
            if (distance < Math.max(14, item.radius + 8) && distance < bestDistance) { best = item; bestDistance = distance; }
        }
        return best;
    }

    function kindLabel(node: GraphNode) {
        return node.kind === 'project' ? 'Proyecto' : node.kind === 'knowledge' ? node.knowledgeKind ?? 'Conocimiento' : `Tarea · ${node.status ?? ''}`;
    }

    function setHover(hit: Projected | undefined, point: Point) {
        const id = hit?.node.id ?? '';
        if (id) focusId = id;
        if (id !== hoveredNodeId) { hoveredNodeId = id; wake(); }
        tooltip = hit ? { node: hit.node, x: clamp(point.x + 14, 8, Math.max(8, width - 250)), y: clamp(point.y + 16, 8, Math.max(8, height - 120)) } : null;
    }

    function zoomBy(factor: number, rel: Point, smooth: boolean) {
        const target = clamp(zoomTarget * factor, ZOOM_MIN, ZOOM_MAX);
        resetting = false;
        if (smooth && !reducedMotion) {
            anchor = { x: rel.x, y: rel.y, panX, panY, zoom };
            zoomTarget = target;
        } else {
            const ratio = target / zoom;
            panX = rel.x - (rel.x - panX) * ratio; panY = rel.y - (rel.y - panY) * ratio;
            zoom = zoomTarget = target; anchor = null;
        }
        wake();
    }
    const fromCenter = (point: Point): Point => ({ x: point.x - width / 2, y: point.y - height / 2 });

    function pointerDown(event: PointerEvent) {
        canvas.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        resetting = false; yawV = pitchV = 0;
        zoomTarget = zoom; anchor = null;
        if (pointers.size === 1) {
            gesture = { mode: event.shiftKey || event.button !== 0 ? 'pan' : 'orbit', moved: 0, lastT: event.timeStamp, lastDist: 0, lastMid: { x: event.clientX, y: event.clientY } };
            tooltip = null;
        } else if (pointers.size === 2 && gesture) {
            const [a, b] = [...pointers.values()];
            gesture.mode = 'pinch'; gesture.moved = 99;
            gesture.lastDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            gesture.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }
    }

    function pointerMove(event: PointerEvent) {
        const previous = pointers.get(event.pointerId);
        if (!gesture || !previous) { setHover(hitTest(local(event)), local(event)); return; }
        const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (gesture.mode === 'pinch' && pointers.size >= 2) {
            const [a, b] = [...pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            panX += mid.x - gesture.lastMid.x; panY += mid.y - gesture.lastMid.y;
            zoomBy(dist / gesture.lastDist, fromCenter(local({ clientX: mid.x, clientY: mid.y })), false);
            gesture.lastDist = dist; gesture.lastMid = mid;
        } else if (gesture.mode === 'pan') {
            gesture.moved += Math.abs(dx) + Math.abs(dy);
            panX += dx; panY += dy;
        } else {
            gesture.moved += Math.abs(dx) + Math.abs(dy);
            const dYaw = dx * 0.008, dPitch = dy * 0.006;
            yaw += dYaw; pitch = clamp(pitch + dPitch, -1.1, 1.1);
            const seconds = Math.max(0.008, (event.timeStamp - gesture.lastT) / 1000);
            yawV = yawV * 0.5 + (dYaw / seconds) * 0.5; pitchV = pitchV * 0.5 + (dPitch / seconds) * 0.5;
            gesture.lastT = event.timeStamp;
        }
        wake();
    }

    function pointerUp(event: PointerEvent) {
        if (!pointers.delete(event.pointerId) || !gesture) return;
        if (pointers.size === 1) { gesture.mode = 'orbit'; yawV = pitchV = 0; return; }
        if (pointers.size > 0) return;
        if (event.type === 'pointerup' && gesture.mode === 'orbit' && gesture.moved <= 3) {
            const hit = hitTest(local(event));
            if (hit) { selectedId = hit.node.id; onSelect(hit.node); wake(); }
        }
        // Only keep the spin if the pointer was still moving when released.
        if (event.timeStamp - gesture.lastT > 80 || reducedMotion || gesture.mode !== 'orbit') yawV = pitchV = 0;
        gesture = null;
        wake();
    }

    function pointerLeave() { if (!gesture) setHover(undefined, { x: 0, y: 0 }); }

    function handleWheel(event: WheelEvent) {
        event.preventDefault();
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? height : 1;
        zoomBy(Math.exp(-event.deltaY * unit * 0.0015), fromCenter(local(event)), true);
    }

    function resetView() {
        yawV = pitchV = 0; anchor = null; zoomTarget = 1;
        if (reducedMotion) { yaw = HOME.yaw; pitch = HOME.pitch; zoom = 1; panX = panY = 0; resetting = false; }
        else { yaw = HOME.yaw + wrap(yaw - HOME.yaw); resetting = true; }
        wake();
    }

    function handleKey(event: KeyboardEvent) {
        const spin = reducedMotion ? 0 : 1.4;
        const nudge = (dYaw: number, dPitch: number) => {
            resetting = false;
            if (spin) { yawV += dYaw * spin; pitchV += dPitch * spin; } else { yaw += dYaw * 0.12; pitch = clamp(pitch + dPitch * 0.12, -1.1, 1.1); }
        };
        const center = { x: 0, y: 0 };
        switch (event.key) {
            case 'ArrowLeft': nudge(-1, 0); break;
            case 'ArrowRight': nudge(1, 0); break;
            case 'ArrowUp': nudge(0, -1); break;
            case 'ArrowDown': nudge(0, 1); break;
            case '+': case '=': zoomBy(1.22, center, true); break;
            case '-': case '_': zoomBy(0.82, center, true); break;
            case '0': resetView(); break;
            default: return;
        }
        event.preventDefault(); wake();
    }

    function onSlider(event: Event) { zoomBy(Number((event.currentTarget as HTMLInputElement).value) / zoomTarget, { x: 0, y: 0 }, false); }
</script>

<div class="graph-shell">
    <div class="graph-toolbar"><span>Arrastra para orbitar · Mayús + arrastrar para mover · rueda o pellizco para acercar · pasa el cursor sobre un nodo para ver sus conexiones</span><div class="zoom-controls"><button type="button" aria-label="Alejar mapa" on:click={() => zoomBy(.82, { x: 0, y: 0 }, true)}>−</button><input aria-label="Nivel de zoom" type="range" min={ZOOM_MIN} max={ZOOM_MAX} step="0.01" value={zoomTarget} on:input={onSlider} /><span>{Math.round(zoomTarget * 100)}%</span><button type="button" aria-label="Acercar mapa" on:click={() => zoomBy(1.22, { x: 0, y: 0 }, true)}>＋</button><button type="button" on:click={resetView}>Restablecer</button></div></div>
    <div class="canvas-wrap">
        <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
        <canvas bind:this={canvas} class:pointing={!!hoveredNodeId} role="application" tabindex="0" aria-label="Grafo tridimensional de proyectos y tareas. Usa las flechas para orbitar y + o − para acercar." on:pointerdown={pointerDown} on:pointermove={pointerMove} on:pointerup={pointerUp} on:pointercancel={pointerUp} on:pointerleave={pointerLeave} on:contextmenu|preventDefault on:keydown={handleKey} on:wheel|nonpassive={handleWheel}></canvas>
        {#if tooltip}
            <div class="graph-tooltip" style="left:{tooltip.x}px; top:{tooltip.y}px">
                <small>{kindLabel(tooltip.node)}</small>
                <strong>{tooltip.node.label}</strong>
                {#if tooltip.node.summary}<p>{tooltip.node.summary.length > 140 ? `${tooltip.node.summary.slice(0, 138)}…` : tooltip.node.summary}</p>{/if}
            </div>
        {/if}
    </div>
    <div class="graph-legend"><span><i class="project"></i>Proyecto</span><span><i class="task"></i>Tarea</span><span><i class="knowledge"></i>Función, dato o módulo</span><span><i class="rel related"></i>Relacionado</span><span><i class="rel parent"></i>Padre de</span><span><i class="rel depends"></i>Depende de</span><span>{nodes.length} elementos</span></div>
    <details class="graph-accessible"><summary>Lista de elementos ({nodes.length})</summary><div>{#each nodes as node (node.id)}<button type="button" on:click={() => { selectedId = node.id; onSelect(node); wake(); }}>{kindLabel(node)} — {node.label}</button>{/each}</div></details>
</div>

<style>
    .graph-shell { min-height: 65vh; overflow: hidden; border-radius: 9px; background: radial-gradient(ellipse at 50% 42%, #2a2d22 0, #191c17 72%); }
    .graph-toolbar,.graph-legend { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: #b8b5a7; padding: 12px 16px; font-size: 11px; }
    .zoom-controls { display:flex; align-items:center; gap:8px; flex:none; }.zoom-controls input { width:110px; accent-color:#b3bd8f; }.zoom-controls span { min-width:38px; text-align:center; font-variant-numeric:tabular-nums; }
    .graph-toolbar button { color: #d9e0bf; background: #24271f; border: 1px solid #3b4034; border-radius: 6px; padding: 6px 9px; cursor: pointer; }
    .graph-toolbar button:hover { border-color: #b3bd8f; }
    .canvas-wrap { position: relative; }
    canvas { width: 100%; height: min(68vh, 680px); min-height: 440px; display: block; cursor: grab; touch-action: none; outline: none; }
    canvas:active { cursor: grabbing; }
    canvas.pointing { cursor: pointer; }
    canvas:focus-visible { box-shadow: inset 0 0 0 2px rgba(179, 189, 143, .55); }
    .graph-tooltip { position: absolute; width: 236px; display: grid; gap: 3px; padding: 10px 12px; border: 1px solid #3b4034; border-radius: 8px; background: rgba(36, 39, 31, .96); box-shadow: 0 8px 24px rgba(0, 0, 0, .35); pointer-events: none; }
    .graph-tooltip small { color: #dfa284; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    .graph-tooltip strong { color: #f2eee3; font-size: 13px; }
    .graph-tooltip p { margin: 0; color: #b8b5a7; font-size: 12px; line-height: 1.45; }
    .graph-legend { justify-content: flex-start; flex-wrap: wrap; border-top: 1px solid #3b4034; }
    .graph-legend span { display: inline-flex; align-items: center; gap: 7px; }
    .graph-legend span:last-child { margin-left: auto; }
    .graph-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #3a4029; border: 1px solid #b3bd8f; }
    .graph-legend i.task { background: #3a3426; border-color: #c4b184; }
    .graph-legend i.knowledge { background: #43312a; border-color: #dfa284; }
    .graph-legend i.rel { width: 20px; height: 0; border: 0; border-top: 2px solid; border-radius: 0; background: none; }
    .graph-legend i.related { border-top-style: dashed; border-color: #c29772; }
    .graph-legend i.parent { border-color: #b3bd8f; }
    .graph-legend i.depends { border-top-style: dotted; border-color: #dfa284; }
    .graph-legend i.parent::after,.graph-legend i.depends::after { content: '▸'; position: relative; left: 15px; top: -9px; font-size: 9px; font-style: normal; color: inherit; }
    .graph-accessible { padding: 0 16px 12px; color:#b8b5a7; font-size:10px; }.graph-accessible summary { cursor:pointer; padding:5px 0 8px; }.graph-accessible>div { display:flex; gap:5px; flex-wrap:wrap; max-height:110px; overflow:auto; }
    .graph-accessible button { color: #d0ccbf; background: #24271f; border: 1px solid #3b4034; border-radius: 5px; font-size: 10px; padding: 5px 7px; cursor: pointer; }
    @media (max-width: 600px) { .graph-toolbar { align-items: flex-start; flex-direction: column; }.zoom-controls { width:100%; flex-wrap:wrap; }.zoom-controls input { flex:1; min-width:80px; } canvas { min-height: 400px; } }
</style>
