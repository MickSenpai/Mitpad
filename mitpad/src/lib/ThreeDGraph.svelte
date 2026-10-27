<script lang="ts">
    import { onMount } from 'svelte';

    type KnowledgeKind = 'module' | 'function' | 'data' | 'capability' | 'integration' | 'decision';
    type GraphNode = { id: string; label: string; kind: 'project' | 'task' | 'knowledge'; projectId: string; x: number; y: number; z: number; status?: string; knowledgeKind?: KnowledgeKind; summary?: string; source?: string; tags?: string[] };
    type GraphLink = { source_project_id: string; target_project_id: string; description?: string };
    export let nodes: GraphNode[] = [];
    export let links: GraphLink[] = [];
    export let onSelect: (node: GraphNode) => void;

    let canvas: HTMLCanvasElement;
    let yaw = -0.55;
    let pitch = 0.22;
    let zoom = 1;
    let drag: { x: number; y: number; moved: boolean; pointerId: number } | null = null;
    let projected: { node: GraphNode; x: number; y: number; scale: number; depth: number }[] = [];
    let width = 900;
    let height = 560;

    $: if (canvas) draw();

    onMount(() => {
        const observer = new ResizeObserver(() => {
            const rect = canvas.getBoundingClientRect();
            width = Math.max(rect.width, 320);
            height = Math.max(rect.height, 440);
            draw();
        });
        observer.observe(canvas);
        draw();
        return () => observer.disconnect();
    });

    function draw() {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        width = rect.width; height = rect.height;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);
        const cx = width / 2, cy = height / 2;
        const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosP = Math.cos(pitch), sinP = Math.sin(pitch);
        const max = Math.max(250, ...nodes.map((n) => Math.hypot(n.x, n.y, n.z)));
        const camera = max * 3.2 / zoom;
        projected = nodes.map((node) => {
            const rx = node.x * cosY - node.z * sinY;
            const rz = node.x * sinY + node.z * cosY;
            const ry = node.y * cosP - rz * sinP;
            const depth = camera + node.y * sinP + rz * cosP;
            const scale = camera / Math.max(1, depth);
            return { node, x: cx + rx * scale, y: cy + ry * scale, scale, depth };
        });
        // Soft floor grid anchors the depth and makes the orbit controls legible.
        ctx.save(); ctx.strokeStyle = 'rgba(122, 153, 175, .10)'; ctx.lineWidth = 1;
        for (let i = -4; i <= 4; i++) {
            const p1 = projectPoint(i * max / 4, max * .42, -max, cx, cy, cosY, sinY, cosP, sinP, camera);
            const p2 = projectPoint(i * max / 4, max * .42, max, cx, cy, cosY, sinY, cosP, sinP, camera);
            const p3 = projectPoint(-max, max * .42, i * max / 4, cx, cy, cosY, sinY, cosP, sinP, camera);
            const p4 = projectPoint(max, max * .42, i * max / 4, cx, cy, cosY, sinY, cosP, sinP, camera);
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.stroke();
        }
        ctx.restore();
        const byId = new Map(projected.map((item) => [item.node.id, item]));
        ctx.lineWidth = 1.4;
        for (const node of nodes.filter((n) => n.kind !== 'project')) {
            const from = byId.get(node.projectId), to = byId.get(node.id);
            if (from && to) edge(ctx, from, to, node.kind === 'knowledge' ? 'rgba(184, 137, 225, .35)' : 'rgba(123, 179, 167, .32)');
        }
        for (const link of links) {
            const from = byId.get(link.source_project_id), to = byId.get(link.target_project_id);
            if (from && to) {
                edge(ctx, from, to, 'rgba(202, 157, 255, .78)', true);
                if (link.description) {
                    ctx.save(); ctx.font = '10px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#d1b8e8';
                    const label = link.description.length > 58 ? `${link.description.slice(0, 56)}…` : link.description;
                    ctx.fillText(label, (from.x + to.x) / 2, (from.y + to.y) / 2 - 8); ctx.restore();
                }
            }
        }
        projected.sort((a, b) => b.depth - a.depth);
        for (const item of projected) {
            const { node, x, y, scale } = item;
            const radius = (node.kind === 'project' ? 18 : node.kind === 'knowledge' ? 8 : 10) * Math.max(.68, Math.min(1.5, scale));
            const fill = node.kind === 'project' ? '#25433d' : node.kind === 'knowledge' ? '#33253f' : node.status === 'done' ? '#263a38' : '#202c3a';
            ctx.beginPath(); ctx.arc(x, y, radius + 6, 0, Math.PI * 2); ctx.fillStyle = node.kind === 'project' ? 'rgba(123, 230, 197, .08)' : node.kind === 'knowledge' ? 'rgba(184, 137, 225, .07)' : 'rgba(116, 169, 255, .06)'; ctx.fill();
            ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
            ctx.strokeStyle = node.kind === 'project' ? '#8ce8d1' : node.kind === 'knowledge' ? '#c496e9' : node.status === 'blocked' ? '#ff927f' : '#7da8e7'; ctx.lineWidth = node.kind === 'project' ? 2 : 1.4; ctx.stroke();
            ctx.font = `${node.kind === 'project' ? '600' : '400'} ${Math.max(10, 12 * Math.min(1.15, scale))}px Inter, system-ui, sans-serif`;
            ctx.textAlign = 'center'; ctx.fillStyle = node.kind === 'project' ? '#d8f7ec' : node.kind === 'knowledge' ? '#d7c6e8' : '#b8c5d2';
            ctx.fillText(node.label.length > 25 ? `${node.label.slice(0, 23)}…` : node.label, x, y + radius + 18);
        }
    }

    function projectPoint(x: number, y: number, z: number, cx: number, cy: number, cosY: number, sinY: number, cosP: number, sinP: number, camera: number) {
        const rx = x * cosY - z * sinY, rz = x * sinY + z * cosY;
        const ry = y * cosP - rz * sinP, depth = camera + y * sinP + rz * cosP, scale = camera / Math.max(1, depth);
        return { x: cx + rx * scale, y: cy + ry * scale };
    }

    function edge(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, color: string, dashed = false) {
        ctx.beginPath(); ctx.setLineDash(dashed ? [5, 5] : []); ctx.strokeStyle = color; ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    }

    function pointerDown(event: PointerEvent) {
        drag = { x: event.clientX, y: event.clientY, moved: false, pointerId: event.pointerId };
        canvas.setPointerCapture(event.pointerId);
    }
    function pointerMove(event: PointerEvent) {
        if (!drag) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        yaw += dx * .008; pitch = Math.max(-1.1, Math.min(1.1, pitch + dy * .006));
        drag.x = event.clientX; drag.y = event.clientY; draw();
    }
    function pointerUp(event: PointerEvent) {
        if (!drag) return;
        if (!drag.moved) {
            const rect = canvas.getBoundingClientRect();
            const hit = [...projected].reverse().find((item) => Math.hypot(item.x - (event.clientX - rect.left), item.y - (event.clientY - rect.top)) < (item.node.kind === 'project' ? 28 : 20));
            if (hit) onSelect(hit.node);
        }
        drag = null;
    }
    function resetView() { yaw = -.55; pitch = .22; zoom = 1; draw(); }
</script>

<div class="graph-shell">
    <div class="graph-toolbar"><span>Arrastra para orbitar · rueda para acercar · selecciona un nodo</span><button type="button" on:click={resetView}>Restablecer vista</button></div>
    <canvas bind:this={canvas} aria-label="Grafo tridimensional de proyectos y tareas" on:pointerdown={pointerDown} on:pointermove={pointerMove} on:pointerup={pointerUp} on:pointercancel={() => drag = null} on:wheel|nonpassive={(event) => { event.preventDefault(); zoom = Math.max(.55, Math.min(2.4, zoom * (event.deltaY < 0 ? 1.08 : .92))); draw(); }}></canvas>
    <div class="graph-legend"><span><i class="project"></i>Proyecto</span><span><i class="task"></i>Tarea</span><span><i class="knowledge"></i>Función, dato o módulo</span><span><i class="relation"></i>Relación descrita</span><span>{nodes.length} elementos</span></div>
    <div class="graph-accessible" aria-label="Elementos del mapa">{#each nodes as node (node.id)}<button type="button" on:click={() => onSelect(node)}>{node.kind === 'project' ? 'Proyecto' : node.kind === 'knowledge' ? `${node.knowledgeKind ?? 'Conocimiento'} · ${node.source ?? ''}` : `Tarea · ${node.status ?? ''}`} — {node.label}</button>{/each}</div>
</div>

<style>
    .graph-shell { min-height: 65vh; overflow: hidden; border-radius: 9px; background: radial-gradient(ellipse at 50% 42%,#1a2832 0,#111820 70%); }
    .graph-toolbar,.graph-legend { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: #92a0af; padding: 12px 16px; font-size: 11px; }
    .graph-toolbar button { color: #b5e8dc; background: #1a2a2c; border: 1px solid #314b49; border-radius: 6px; padding: 6px 9px; cursor: pointer; }
    canvas { width: 100%; height: min(68vh, 680px); min-height: 440px; display: block; cursor: grab; touch-action: none; }
    canvas:active { cursor: grabbing; }
    .graph-legend { justify-content: flex-start; flex-wrap: wrap; border-top: 1px solid #27333d; }
    .graph-legend span { display: inline-flex; align-items: center; gap: 7px; }
    .graph-legend span:last-child { margin-left: auto; }
    .graph-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #25433d; border: 1px solid #8ce8d1; }
    .graph-legend i.task { background: #202c3a; border-color: #7da8e7; }
    .graph-legend i.knowledge { background: #33253f; border-color: #c496e9; }
    .graph-legend i.relation { width: 20px; height: 0; border: 0; border-top: 2px dashed #ca9fff; border-radius: 0; }
    .graph-accessible { display: flex; gap: 5px; flex-wrap: wrap; max-height: 82px; overflow: auto; padding: 0 16px 12px; }
    .graph-accessible button { color: #a8b6c4; background: #19212b; border: 1px solid #2b3846; border-radius: 5px; font-size: 10px; padding: 5px 7px; cursor: pointer; }
    @media (max-width: 600px) { .graph-toolbar { align-items: flex-start; flex-direction: column; } canvas { min-height: 400px; } }
</style>
