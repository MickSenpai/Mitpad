<script lang="ts">
	import { onMount } from 'svelte';

	const endpoint = 'https://mitpad.onrender.com/mcp';
	const agentPrompt = `Conecta este agente con Mitpad, mi workspace para coordinar proyectos y memoria compartida.

Mitpad MCP remoto: ${endpoint}
Transporte: Streamable HTTP
Autenticación: Bearer token individual de Mitpad. Pídeme que lo cree en la sección Agentes y guíame para guardarlo en un archivo local privado. Nunca escribas la clave en el chat, el repositorio o los logs.

Configura la conexión MCP para este cliente, comprueba que el servidor responde y realiza solo una consulta de lectura para confirmar la conexión. No crees ni edites datos hasta que te lo solicite.`;

	let copied = false;
	let canvas: HTMLCanvasElement;

	async function copyPrompt() {
		try {
			await navigator.clipboard.writeText(agentPrompt);
			copied = true;
			setTimeout(() => (copied = false), 2200);
		} catch {
			copied = false;
		}
	}

	/* ------------------------------------------------------------------
	   Grafo de la "M": coordenadas tomadas del logo (1165 × 870 unidades).
	   kind: 'g' = nodo con brillo, 'v' = nodo violeta de esquina.
	------------------------------------------------------------------ */
	type Point = [x: number, y: number, kind?: 'g' | 'v', label?: string];

	const POINTS: Point[] = [
		[380, 528, , 'Notas'], [690, 528], [1232, 528], [1545, 528, 'v'],
		[540, 795, 'g', 'Decisiones'], [700, 755], [965, 805, , 'Proyecto'], [1230, 745],
		[1384, 780, 'g', 'Memoria'], [380, 938], [685, 987], [967, 1020],
		[1249, 987, 'g', 'Agentes'], [1543, 938], [478, 1088], [551, 1207, 'g'],
		[965, 1257, 'g', 'Tareas'], [1428, 1125], [380, 1398, 'v'], [685, 1398],
		[1250, 1398], [1545, 1398, , 'Archivos']
	];

	const EDGES: [number, number][] = [
		[0, 1], [0, 4], [0, 5], [0, 9], [1, 4], [1, 6], [1, 16], [2, 6], [2, 3], [2, 8], [2, 16],
		[3, 7], [3, 8], [3, 13], [4, 5], [4, 9], [4, 10], [4, 14], [5, 6], [6, 7], [6, 10], [6, 12],
		[7, 8], [8, 13], [8, 12], [8, 17], [9, 14], [9, 18], [10, 11], [10, 16], [10, 15], [10, 19],
		[11, 12], [12, 16], [12, 21], [12, 20], [13, 17], [13, 21], [14, 15], [14, 18], [15, 18],
		[15, 19], [17, 20], [17, 21], [18, 19], [20, 21]
	];

	function startGraph(cv: HTMLCanvasElement) {
		const ctx = cv.getContext('2d')!;
		const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
		const N = POINTS.length;

		// color por nodo: azul a la izquierda, verde azulado a la derecha, violeta en las esquinas
		const hue = POINTS.map(([x, , k]) => (k === 'v' ? 24 : 150 - 112 * ((x - 380) / 1165)));
		const light = POINTS.map(([, , k]) => (k === 'v' ? 72 : 58));
		const hsla = (i: number, a: number) => `hsl(${hue[i]} 78% ${light[i]}% / ${a})`;

		const adj: number[][] = Array.from({ length: N }, () => []);
		EDGES.forEach(([a, b]) => { adj[a].push(b); adj[b].push(a); });

		const phase = POINTS.map((_, i) => i * 1.7);
		const depth = POINTS.map((_, i) => 0.4 + ((i * 7) % 5) * 0.18);
		const energy = new Float32Array(N);
		const P = POINTS.map(() => ({ x: 0, y: 0 }));
		const pulses: { a: number; b: number; t: number; speed: number; hops: number }[] = [];

		let W = 0, H = 0, scale = 1, ox = 0, oy = 0;
		let mouse = { x: 0, y: 0, active: false };
		let pm = { x: 0, y: 0 };
		let hover = -1;
		let nextPulse = 1.2;
		let raf = 0;
		const t0 = performance.now();
		let last = t0;

		const clamp = (v: number) => Math.max(0, Math.min(1, v));
		const ease = (v: number) => 1 - Math.pow(1 - v, 3);
		const appear = (i: number, el: number) => ease(clamp((el - 200 - i * 55) / 650));

		function resize() {
			const r = cv.getBoundingClientRect();
			const dpr = Math.min(devicePixelRatio || 1, 2);
			W = r.width; H = r.height;
			cv.width = W * dpr; cv.height = H * dpr;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const pad = Math.min(W, H) * 0.08;
			scale = Math.min((W - pad * 2) / 1165, (H - pad * 2) / 870);
			ox = (W - 1165 * scale) / 2 - 380 * scale;
			oy = (H - 870 * scale) / 2 - 528 * scale;
			if (reduce) frame(performance.now());
		}

		function spawn(a: number, from = -1, hops = 3) {
			const options = adj[a].filter((n) => n !== from);
			const pool = options.length ? options : adj[a];
			const b = pool[(Math.random() * pool.length) | 0];
			pulses.push({ a, b, t: 0, speed: 0.55 + Math.random() * 0.4, hops });
		}

		function frame(now: number) {
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			const el = reduce ? 1e6 : now - t0;

			pm.x += ((mouse.active ? mouse.x / W - 0.5 : 0) - pm.x) * Math.min(1, dt * 4);
			pm.y += ((mouse.active ? mouse.y / H - 0.5 : 0) - pm.y) * Math.min(1, dt * 4);

			POINTS.forEach(([bx, by], i) => {
				const drift = reduce ? 0 : 1;
				P[i].x = ox + bx * scale + pm.x * depth[i] * 26 + Math.sin(now / 1700 + phase[i]) * 2.2 * drift;
				P[i].y = oy + by * scale + pm.y * depth[i] * 26 + Math.cos(now / 1900 + phase[i]) * 2.2 * drift;
			});

			const r0 = Math.max(5, 29 * scale);
			const lw = Math.max(1.5, 5 * scale);

			// nodo bajo el cursor
			let h = -1;
			if (mouse.active) {
				let best = Math.max(16, r0 * 2.2);
				P.forEach((p, i) => {
					const d = Math.hypot(p.x - mouse.x, p.y - mouse.y);
					if (d < best) { best = d; h = i; }
				});
			}
			if (h !== hover) {
				hover = h;
				if (h >= 0 && !reduce) adj[h].forEach((n) => pulses.push({ a: h, b: n, t: 0, speed: 1.3, hops: 0 }));
			}

			if (!reduce) {
				nextPulse -= dt;
				if (nextPulse <= 0 && pulses.length < 9 && el > 1800) {
					spawn((Math.random() * N) | 0);
					nextPulse = 0.5 + Math.random() * 0.8;
				}
			}

			ctx.clearRect(0, 0, W, H);
			ctx.lineCap = 'round';

			// aristas
			for (const [a, b] of EDGES) {
				const al = Math.min(appear(a, el), appear(b, el));
				if (al <= 0) continue;
				const A = P[a], B = P[b];
				const lit = hover >= 0 && (a === hover || b === hover);
				const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
				g.addColorStop(0, hsla(a, 1));
				g.addColorStop(1, hsla(b, 1));
				ctx.globalAlpha = al * (hover < 0 ? 0.6 : lit ? 1 : 0.18);
				ctx.strokeStyle = g;
				ctx.lineWidth = lit ? lw * 1.4 : lw;
				ctx.beginPath();
				ctx.moveTo(A.x, A.y);
				ctx.lineTo(A.x + (B.x - A.x) * al, A.y + (B.y - A.y) * al);
				ctx.stroke();
			}
			ctx.globalAlpha = 1;

			// pulsos de señal que viajan por el grafo
			ctx.globalCompositeOperation = 'lighter';
			for (let k = pulses.length - 1; k >= 0; k--) {
				const p = pulses[k];
				p.t += dt * p.speed;
				if (p.t >= 1) {
					energy[p.b] = 1;
					pulses.splice(k, 1);
					if (p.hops > 0 && Math.random() < 0.7) spawn(p.b, p.a, p.hops - 1);
					continue;
				}
				const A = P[p.a], B = P[p.b];
				const x = A.x + (B.x - A.x) * p.t, y = A.y + (B.y - A.y) * p.t;
				const t2 = Math.max(0, p.t - 0.16);
				const x2 = A.x + (B.x - A.x) * t2, y2 = A.y + (B.y - A.y) * t2;
				const tail = ctx.createLinearGradient(x2, y2, x, y);
				tail.addColorStop(0, hsla(p.a, 0));
				tail.addColorStop(1, hsla(p.b, 0.95));
				ctx.strokeStyle = tail;
				ctx.lineWidth = lw * 1.2;
				ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x, y); ctx.stroke();
				const halo = ctx.createRadialGradient(x, y, 0, x, y, lw * 4.5);
				halo.addColorStop(0, hsla(p.b, 0.9));
				halo.addColorStop(1, hsla(p.b, 0));
				ctx.fillStyle = halo;
				ctx.beginPath(); ctx.arc(x, y, lw * 4.5, 0, 6.2832); ctx.fill();
			}
			ctx.globalCompositeOperation = 'source-over';

			// nodos
			const near = hover >= 0 ? new Set([hover, ...adj[hover]]) : null;
			for (let i = 0; i < N; i++) {
				const ap = appear(i, el);
				if (ap <= 0) continue;
				energy[i] = Math.max(0, energy[i] - dt * 1.8);
				const glow = POINTS[i][2] === 'g';
				const r = r0 * (glow ? 1.12 : 1) * ap * (1 + energy[i] * 0.14);
				const { x, y } = P[i];
				ctx.globalAlpha = ap * (near && !near.has(i) ? 0.35 : 1);

				const haloA = (glow ? 0.34 + 0.1 * Math.sin(now / 900 + phase[i]) : 0) + energy[i] * 0.5 + (i === hover ? 0.3 : 0);
				if (haloA > 0.02) {
					const rad = r * (glow ? 3.6 : 2.8);
					const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, rad);
					g.addColorStop(0, hsla(i, haloA));
					g.addColorStop(1, hsla(i, 0));
					ctx.fillStyle = g;
					ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.2832); ctx.fill();
				}
				ctx.fillStyle = hsla(i, 1);
				ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
				if (glow) {
					ctx.fillStyle = 'rgba(255,255,255,.85)';
					ctx.beginPath(); ctx.arc(x, y, r * 0.17, 0, 6.2832); ctx.fill();
				}
				if (i === hover) {
					ctx.strokeStyle = 'rgba(255,255,255,.75)';
					ctx.lineWidth = 1.5;
					ctx.beginPath(); ctx.arc(x, y, r + 5, 0, 6.2832); ctx.stroke();
				}
			}
			ctx.globalAlpha = 1;

			// etiqueta del nodo
			const label = hover >= 0 ? POINTS[hover][3] : undefined;
			if (label) {
				ctx.font = '600 13px "Instrument Sans", system-ui, sans-serif';
				const w = ctx.measureText(label).width + 22, hh = 28;
				const lx = Math.min(Math.max(8, P[hover].x + r0 * 1.7), W - w - 8);
				const ly = Math.max(8, P[hover].y - r0 * 1.7 - hh);
				ctx.fillStyle = 'rgba(22,26,37,.94)';
				ctx.strokeStyle = hsla(hover, 0.9);
				ctx.lineWidth = 1;
				ctx.beginPath();
				if (ctx.roundRect) ctx.roundRect(lx, ly, w, hh, 7); else ctx.rect(lx, ly, w, hh);
				ctx.fill(); ctx.stroke();
				ctx.fillStyle = '#e8ecf5';
				ctx.textBaseline = 'middle';
				ctx.fillText(label, lx + 11, ly + hh / 2 + 0.5);
			}
		}

		const loop = (t: number) => { frame(t); raf = requestAnimationFrame(loop); };
		const play = () => { if (!raf && !reduce) { last = performance.now(); raf = requestAnimationFrame(loop); } };
		const pause = () => { cancelAnimationFrame(raf); raf = 0; };

		const onMove = (e: PointerEvent) => {
			const r = cv.getBoundingClientRect();
			mouse = { x: e.clientX - r.left, y: e.clientY - r.top, active: true };
		};
		const onLeave = () => { mouse.active = false; };

		cv.addEventListener('pointermove', onMove);
		cv.addEventListener('pointerleave', onLeave);
		const ro = new ResizeObserver(resize);
		ro.observe(cv);
		const io = new IntersectionObserver(([entry]) => (entry.isIntersecting ? play() : pause()));
		io.observe(cv);
		resize();

		return () => {
			pause(); ro.disconnect(); io.disconnect();
			cv.removeEventListener('pointermove', onMove);
			cv.removeEventListener('pointerleave', onLeave);
		};
	}

	onMount(() => startGraph(canvas));
</script>

<svelte:head>
	<title>Mitpad — El workspace que tus agentes pueden recordar</title>
	<meta name="description" content="Coordina proyectos, memoria y agentes de IA en un workspace compartido. Conecta clientes MCP con una clave individual y conserva el control." />
	<meta name="theme-color" content="#1c202b" />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet" />
</svelte:head>

<main class="landing">
	<header class="topbar wrap">
		<a class="brand" href="/" aria-label="Mitpad, inicio">
			<img src="/mitpad-mark-web.webp" alt="" width="32" height="32" />
			<span>mitpad</span>
		</a>
		<nav aria-label="Principal">
			<a href="#como-funciona">Cómo funciona</a>
			<a href="#conectar">Conectar</a>
			<a href="#agentes">Agentes</a>
			<a href="#tecnologia">Tecnología</a>
		</nav>
		<a class="btn btn-outline" href="/app">Abrir workspace</a>
	</header>

	<section class="hero wrap">
		<div class="hero-copy">
			<p class="hero-kicker"><span></span> Un lugar para continuar donde quedó el equipo</p>
			<h1>Que el trabajo no pierda el hilo.</h1>
			<p class="lede">
				Reúne proyectos, decisiones y pendientes en un mismo lugar. Tus agentes pueden consultar
				ese contexto; tú eliges a quién invitar y qué puede hacer.
			</p>
			<div class="actions">
				<a class="btn btn-primary" href="/app">Entrar a Mitpad</a>
				<a class="link" href="#conectar">Conectar un agente ↓</a>
			</div>
			<p class="fine">Cada agente entra con su propia llave. Si el equipo cambia, la revocas.</p>
		</div>

		<div class="hero-graph">
			<canvas bind:this={canvas} aria-label="Grafo de nodos conectados con forma de la letra M, por donde viajan señales entre proyectos, memoria, tareas y agentes"></canvas>
			<p class="hint">Pasa el cursor por los nodos</p>
		</div>
	</section>

	<section class="statement block wrap">
		<h2>Menos volver a explicar. Más seguir adelante.</h2>
		<div>
			<p>
				Las decisiones no se pierden entre chats y las tareas no viven en una herramienta aparte.
				Mitpad guarda lo que el equipo necesita para retomar el trabajo con claridad, incluso cuando
				cambia quién está al frente.
			</p>
			<a class="link" href="/app">Explora tu workspace ↗</a>
		</div>
	</section>

	<section class="features block wrap" id="como-funciona">
		<h2 class="section-title">El trabajo real, con su contexto alrededor.</h2>

		<article class="feature">
			<div class="feature-text">
				<h3>Lo que ya aprendieron, se queda</h3>
				<p>Guarda decisiones, notas y detalles que normalmente se pierden en una conversación. Compártelos solo con los agentes que autorices.</p>
			</div>
			<ul class="panel log" aria-label="Ejemplo de memoria del proyecto">
				<li><span class="tag tag-decision">Decisión</span><p>Migrar la autenticación a Convex</p><time>hoy, 10:42</time></li>
				<li><span class="tag tag-note">Nota</span><p>El cliente prefiere revisar los cambios por la tarde</p><time>ayer</time></li>
				<li><span class="tag tag-todo">Pendiente</span><p>Documentar el flujo de importación de archivos</p><time>hace 3 días</time></li>
			</ul>
		</article>

		<article class="feature flip">
			<div class="feature-text">
				<h3>Un tablero que cuenta qué pasó</h3>
				<p>Revisa tareas, responsables y cambios recientes. Cuando un agente avanza algo, queda a la vista para que puedas retomarlo o corregir el rumbo.</p>
			</div>
			<ul class="panel tasks" aria-label="Ejemplo de tareas">
				<li class="done"><i></i><span>Preparar el contexto</span><b>Hecha</b></li>
				<li class="active"><i></i><span>Implementar el cambio</span><b class="by">Meido está en ello</b></li>
				<li><i></i><span>Revisar con el equipo</span><b>Pendiente</b></li>
			</ul>
		</article>

		<article class="feature">
			<div class="feature-text">
				<h3>Ve las conexiones, no solo las listas</h3>
				<p>Explora cómo una decisión, una tarea y otro proyecto se tocan. El mapa ayuda a encontrar dependencias que suelen quedar escondidas.</p>
			</div>
			<div class="panel relations">
				<svg viewBox="0 0 360 210" role="img" aria-label="Mitpad, Meido y CosechIA conectados entre sí">
					<line class="flow" x1="180" y1="58" x2="78" y2="150" />
					<line class="flow slow" x1="180" y1="58" x2="284" y2="150" />
					<line x1="78" y1="150" x2="284" y2="150" class="faint" />
					<text x="96" y="96" class="edge-label">comparte conocimiento</text>
					<circle cx="180" cy="58" r="13" fill="#2cc3ee" /><circle cx="180" cy="58" r="22" fill="#2cc3ee" opacity=".14" />
					<circle cx="78" cy="150" r="13" fill="#3f9be6" /><circle cx="284" cy="150" r="13" fill="#48dcb9" />
					<text x="180" y="28" text-anchor="middle">Mitpad</text>
					<text x="78" y="187" text-anchor="middle">Meido</text>
					<text x="284" y="187" text-anchor="middle">CosechIA</text>
				</svg>
			</div>
		</article>
	</section>

	<section class="connect block wrap" id="conectar">
		<div class="connect-copy">
			<h2>Una instrucción y tu agente ya tiene contexto</h2>
			<p>Copia este prompt y pégalo en tu agente. Te guiará para configurar una conexión MCP segura y comprobarla con una lectura.</p>
			<ol class="steps">
				<li>Inicia sesión en Mitpad y crea una credencial para cada agente en <a href="/app">Workspace → Agentes</a>.</li>
				<li>La clave se muestra una sola vez. Guárdala en tu equipo y limita el acceso al usuario que ejecuta el agente.</li>
				<li>Comprueba la conexión con una lectura. Mantén el control de las acciones y revoca los accesos que ya no uses.</li>
			</ol>
		</div>

		<div class="prompt">
			<div class="prompt-head">
				<strong>Prompt de conexión</strong>
				<span>MCP remoto · Streamable HTTP</span>
			</div>
			<pre>{agentPrompt}</pre>
			<div class="prompt-foot">
				<code>{endpoint}</code>
				<button class="btn btn-primary" class:ok={copied} on:click={copyPrompt} aria-live="polite">
					{copied ? 'Copiado' : 'Copiar prompt'}
				</button>
			</div>
		</div>
	</section>

	<section class="clients block wrap" id="agentes">
		<div class="clients-intro">
			<h2>Elige tu agente. Mitpad conserva el contexto.</h2>
			<p>Funciona con cualquier cliente que implemente MCP remoto por Streamable HTTP y admita cabeceras de autorización.</p>
		</div>
		<div>
			<ul class="client-list">
				<li><strong>OpenCode</strong><span>Cliente MCP remoto</span></li>
				<li><strong>Codex</strong><span>Según la configuración MCP del cliente</span></li>
				<li><strong>Claude Code</strong><span>Con servidor HTTP compatible</span></li>
				<li><strong>Cursor</strong><span>Con soporte de servidor MCP remoto</span></li>
				<li><strong>Otros clientes</strong><span>Cualquiera compatible con Streamable HTTP</span></li>
			</ul>
			<p class="note">Registrar el servidor y pasar el token cambia según el cliente; el prompt de conexión adapta la guía. Nunca incluyas la clave en el texto del prompt.</p>
		</div>
	</section>

	<section class="tech block wrap" id="tecnologia">
		<div class="tech-copy">
			<h2>Una base pequeña, un flujo conectado</h2>
			<p>Proyectos, memoria y agentes comparten un mismo espacio privado. Convex mantiene los datos sincronizados y el servidor MCP conecta los clientes que tú autorizas.</p>
			<a class="link" href="/app">Abre tu workspace ↗</a>
		</div>
		<dl class="stack">
			<div><dt>SvelteKit</dt><dd>Interfaz web rápida y adaptable</dd><span>Web</span></div>
			<div><dt>Convex</dt><dd>Datos reactivos, autenticación y archivos</dd><span>Backend</span></div>
			<div><dt>MCP</dt><dd>Protocolo abierto para conectar agentes</dd><span>Agentes</span></div>
			<div><dt>Convex Auth</dt><dd>Acceso y espacio privado por cuenta</dd><span>Identidad</span></div>
		</dl>
	</section>

	<footer class="footer wrap">
		<a class="brand" href="/"><img src="/mitpad-mark-web.webp" alt="" width="28" height="28" /><span>mitpad</span></a>
		<p>El contexto de tu proyecto, conectado.</p>
		<nav aria-label="Pie"><a href="/app">Iniciar sesión</a><a href="#conectar">Conectar agente</a></nav>
	</footer>
</main>

<style>
	:global(*) { box-sizing: border-box; }
	:global(html) { scroll-behavior: smooth; }
	:global(body) { margin: 0; background: #191c17; }
	:global(::selection) { background: #aeb98a; color: #191c17; }

	.landing {
		--bg: #191c17;
		--panel: #24271f;
		--line: #3b4034;
		--text: #f2eee3;
		--muted: #b8b5a7;
		--cyan: #b3bd8f;
		--blue: #c29772;
		--teal: #dfa284;
		--violet: #b6bf90;
		--display: 'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif;
		--body: 'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
		--mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

		min-height: 100vh;
		overflow-x: hidden;
		background: radial-gradient(ellipse at 82% 12%, rgba(174,185,138,.08), transparent 34%), var(--bg);
		color: var(--text);
		font-family: var(--body);
		font-size: 16px;
		line-height: 1.6;
	}

	.wrap { width: 100%; max-width: 1240px; margin-inline: auto; padding-inline: clamp(20px, 5vw, 48px); }
	.block { padding-block: clamp(72px, 10vw, 128px); }

	a { color: inherit; }
	:global(.landing a:focus-visible), :global(.landing button:focus-visible) {
		outline: 2px solid var(--cyan);
		outline-offset: 3px;
		border-radius: 4px;
	}

	h1, h2, h3 { font-family: var(--display); font-weight: 600; margin: 0; letter-spacing: -0.03em; }
	h2 { font-size: clamp(30px, 3.8vw, 46px); line-height: 1.08; text-wrap: balance; }
	p { margin: 0; }

	/* --- navegación --- */
	.topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; height: 76px; border-bottom: 1px solid transparent; background: #191c17db; backdrop-filter: blur(14px); transition: border-color .2s; }
	.brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; font: 600 20px var(--display); letter-spacing: -0.03em; }
	.brand img { border-radius: 9px; display: block; }
	.topbar nav { display: flex; gap: 32px; }
	.topbar nav a, .footer nav a { color: var(--muted); text-decoration: none; font-size: 14.5px; transition: color 0.2s; }
	.topbar nav a:hover, .footer nav a:hover { color: var(--text); }

	.btn {
		display: inline-flex; align-items: center; justify-content: center;
		padding: 11px 18px; border-radius: 8px; border: 1px solid transparent;
		font: 600 14.5px var(--body); text-decoration: none; cursor: pointer;
		transition: background 0.2s, border-color 0.2s, transform 0.2s;
	}
	.btn-primary { background: var(--teal); color: #251b16; }
	.btn-primary:hover { background: #edb497; }
	.btn-primary:active { transform: translateY(1px); }
	.btn-outline { border-color: #615347; color: var(--text); }
	.btn-outline:hover { border-color: var(--cyan); }

	.link { color: var(--text); text-decoration: underline; text-decoration-color: #685b48; text-underline-offset: 5px; font-size: 15px; transition: text-decoration-color 0.2s; }
	.link:hover { text-decoration-color: var(--teal); }

	/* --- hero --- */
	.hero {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
		align-items: center;
		gap: 24px;
		padding-block: clamp(24px, 5vw, 56px) clamp(48px, 7vw, 96px);
	}
	.hero-copy { animation: settle 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
	.hero-kicker { display:flex; align-items:center; gap:10px; margin:0 0 21px; color:#c6c99d; font-size:12px; letter-spacing:.04em; }
	.hero-kicker span { width:8px; height:8px; border-radius:50%; background:#b3bd8f; box-shadow:0 0 0 5px #b3bd8f1c; animation: breathe 2.8s ease-in-out infinite; }
	.hero h1 { max-width: 11ch; font-size: clamp(48px, 6.2vw, 84px); line-height: 0.96; letter-spacing: -0.055em; text-wrap: balance; }
	.lede { margin-top: 26px; max-width: 46ch; font-size: 18px; color: #c4c1b5; }
	.actions { display: flex; align-items: center; gap: 28px; margin-top: 34px; flex-wrap: wrap; }
	.fine { margin-top: 30px; max-width: 44ch; font-size: 14px; color: var(--muted); }

	.hero-graph { position: relative; height: clamp(360px, 46vw, 600px); margin-right: -2%; border-radius:50%; isolation:isolate; }
	.hero-graph canvas { display: block; width: 100%; height: 100%; touch-action: pan-y; }
	.hero-graph::before {
		content: ''; position: absolute; inset: 14% 10%; z-index: -1; border-radius: 50%;
		background: radial-gradient(closest-side, rgba(174,185,138,.16), rgba(217,154,121,.07) 60%, transparent);
		filter: blur(30px);
	}
	.hint { position: absolute; left: 4%; bottom: 2%; padding:7px 11px; border:1px solid #ffffff13; border-radius:99px; background:#20231cc9; font-size: 12px; color: #c0beb2; }

	/* --- declaración --- */
	.statement { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: clamp(32px, 6vw, 88px); align-items: end; border-top: 1px solid var(--line); }
	.statement h2 { font-size: clamp(34px, 4.6vw, 60px); }
	.statement p { color: #b7c0d1; max-width: 52ch; margin-bottom: 22px; }

	/* --- funciones --- */
	.section-title { margin-bottom: clamp(36px, 6vw, 72px); }
	.feature { display: grid; grid-template-columns: 0.8fr 1.2fr; gap: clamp(28px, 6vw, 88px); align-items: center; padding-block: 36px; }
	.feature + .feature { border-top: 1px solid var(--line); }
	.feature.flip { grid-template-columns: 1.2fr 0.8fr; }
	.feature.flip .feature-text { order: 2; }
	.feature h3 { font-size: 26px; line-height: 1.15; margin-bottom: 12px; }
	.feature-text p { color: #b0b9ca; max-width: 40ch; }

	.panel { margin: 0; padding: 0; list-style: none; background: linear-gradient(145deg,#292c23,var(--panel)); border: 1px solid var(--line); border-radius: 16px; box-shadow:0 18px 50px #00000014; }

	.log li { display: grid; grid-template-columns: 88px 1fr auto; align-items: center; gap: 16px; padding: 18px 22px; font-size: 15px; }
	.log li + li { border-top: 1px solid var(--line); }
	.log time { color: #7c879d; font-size: 13px; white-space: nowrap; }
	.tag { justify-self: start; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; }
	.tag-decision { background: rgba(44, 195, 238, 0.14); color: #6fd8f5; }
	.tag-note { background: rgba(72, 220, 185, 0.13); color: #7ce8cb; }
	.tag-todo { background: rgba(164, 141, 242, 0.16); color: #c0b0f6; }

	.tasks li { display: flex; align-items: center; gap: 14px; padding: 17px 22px; font-size: 15px; color: #b7c0d1; }
	.tasks li + li { border-top: 1px solid var(--line); }
	.tasks i { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid #5a6580; flex: none; }
	.tasks span { flex: 1; }
	.tasks b { font-size: 13px; font-weight: 500; color: #7c879d; }
	.tasks .done i { background: var(--teal); border-color: var(--teal); }
	.tasks .done span { text-decoration: line-through; text-decoration-color: #5a6580; }
	.tasks .active { background: #29304a; color: var(--text); border-radius: 0; }
	.tasks .active i { border-color: var(--cyan); box-shadow: 0 0 0 0 rgba(44, 195, 238, 0.5); animation: ping 2s ease-out infinite; }
	.tasks .by { color: var(--cyan); }

	.relations { padding: 20px; }
	.relations svg { display: block; width: 100%; height: auto; max-height: 260px; }
	.relations text { fill: #d2d9e8; font: 500 13px var(--body); }
	.relations line { stroke: #4fb8c9; stroke-width: 2; }
	.relations .faint { stroke: #3a4258; stroke-dasharray: 3 6; }
	.relations .flow { stroke-dasharray: 6 8; animation: dash 1.6s linear infinite; }
	.relations .flow.slow { animation-duration: 2.4s; }
	.relations .edge-label { fill: #8995ad; font-size: 12px; }

	/* --- conexión --- */
	.connect { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: clamp(32px, 6vw, 80px); align-items: start; border-top: 1px solid var(--line); }
	.connect-copy > p { margin-top: 18px; color: #b0b9ca; max-width: 42ch; }
	.steps { margin: 32px 0 0; padding: 0; list-style: none; counter-reset: step; display: grid; gap: 18px; }
	.steps li { counter-increment: step; position: relative; padding-left: 38px; font-size: 14.5px; color: var(--muted); max-width: 46ch; }
	.steps li::before {
		content: counter(step); position: absolute; left: 0; top: 1px; width: 24px; height: 24px;
		display: grid; place-items: center; border: 1px solid #465069; border-radius: 50%;
		font: 12px var(--mono); color: var(--teal);
	}
	.steps a { color: var(--text); text-underline-offset: 3px; }

	.prompt { background: #171b25; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
	.prompt-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 20px; background: #1e2330; border-bottom: 1px solid var(--line); font-size: 14px; }
	.prompt-head span { color: #7c879d; font-size: 13px; }
	.prompt pre { margin: 0; padding: 22px 20px; font: 13px/1.8 var(--mono); color: #ccd3e2; white-space: pre-wrap; overflow-wrap: anywhere; }
	.prompt-foot { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 20px; border-top: 1px solid var(--line); }
	.prompt-foot code { font: 12.5px var(--mono); color: #7ec9d9; overflow-wrap: anywhere; }
	.prompt-foot .btn { flex: none; min-width: 132px; }
	.prompt-foot .ok { background: #fff; }

	/* --- clientes --- */
	.clients { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: clamp(32px, 6vw, 80px); border-top: 1px solid var(--line); }
	.clients-intro p { margin-top: 18px; color: #b0b9ca; max-width: 40ch; }
	.client-list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
	.client-list li { display: flex; justify-content: space-between; align-items: baseline; gap: 20px; padding: 18px 4px; border-bottom: 1px solid var(--line); transition: padding 0.25s, background 0.25s; }
	.client-list li:hover { padding-inline: 14px; background: #20253400; background: #202534; }
	.client-list strong { font: 600 19px var(--display); letter-spacing: -0.02em; }
	.client-list span { font-size: 14px; color: var(--muted); text-align: right; }
	.note { margin-top: 18px; font-size: 13.5px; color: #7c879d; max-width: 58ch; }

	/* --- tecnología --- */
	.tech { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: clamp(32px, 6vw, 80px); border-top: 1px solid var(--line); }
	.tech-copy p { margin: 18px 0 22px; color: #b0b9ca; max-width: 44ch; }
	.stack { margin: 0; border-top: 1px solid var(--line); }
	.stack div { display: grid; grid-template-columns: 150px 1fr auto; gap: 16px; align-items: baseline; padding: 18px 4px; border-bottom: 1px solid var(--line); }
	.stack dt { font: 600 18px var(--display); letter-spacing: -0.02em; }
	.stack dd { margin: 0; font-size: 14.5px; color: var(--muted); }
	.stack span { font-size: 13px; color: var(--teal); }

	/* --- pie --- */
	.footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding-block: 34px; border-top: 1px solid var(--line); }
	.footer .brand { font-size: 17px; }
	.footer p { font-size: 14px; color: #7c879d; }
	.footer nav { display: flex; gap: 24px; }

	/* --- movimiento --- */
	@keyframes settle { from { opacity: 0; translate: 0 14px; } to { opacity: 1; translate: 0 0; } }
	@keyframes breathe { 50% { box-shadow:0 0 0 9px #b3bd8f05; opacity:.7; } }
	@keyframes ping { 0% { box-shadow: 0 0 0 0 rgba(44, 195, 238, 0.5); } 80%, 100% { box-shadow: 0 0 0 9px rgba(44, 195, 238, 0); } }
	@keyframes dash { to { stroke-dashoffset: -28; } }

	@media (prefers-reduced-motion: reduce) {
		:global(html) { scroll-behavior: auto; }
		.hero-copy, .hero-kicker span, .tasks .active i, .relations .flow { animation: none; }
		.btn, .client-list li { transition: none; }
	}

	/* --- responsive --- */
	@media (max-width: 900px) {
		.topbar nav { display: none; }
		.hero { grid-template-columns: 1fr; }
		.hero-graph { margin-right: 0; }
		.statement, .feature, .feature.flip, .connect, .clients, .tech { grid-template-columns: 1fr; }
		.feature.flip .feature-text { order: 0; }
		.footer { flex-wrap: wrap; }
	}
	@media (max-width: 560px) {
		.log li { grid-template-columns: 1fr auto; }
		.log li p { grid-column: 1 / -1; grid-row: 2; }
		.client-list li { flex-direction: column; gap: 2px; }
		.client-list span { text-align: left; }
		.stack div { grid-template-columns: 1fr auto; }
		.stack dd { grid-column: 1 / -1; grid-row: 2; }
		.prompt-foot { flex-direction: column; align-items: stretch; }
	}
	/* Paleta Mitpad: tierra oscura, salvia y terracota. */
	.tag-decision { background: rgba(194, 151, 114, 0.15); color: #dfb18c; }
	.tag-note { background: rgba(174, 185, 138, 0.15); color: #c2c99c; }
	.tag-todo { background: rgba(217, 154, 121, 0.15); color: #e5a98b; }
	.tasks li { color: #c4c1b5; }
	.tasks i { border-color: #77765f; }
	.tasks b, .log time, .note, .footer p { color: #aaa99b; }
	.tasks .done i { background: var(--teal); border-color: var(--teal); }
	.tasks .active { background: #34372c; color: var(--text); }
	.tasks .active i { border-color: var(--cyan); box-shadow: 0 0 0 0 rgba(174, 185, 138, 0.5); }
	.relations text { fill: #e8e2d4; }
	.relations line { stroke: #b5a079; }
	.relations .faint { stroke: #434438; }
	.relations .edge-label, .prompt-head span { fill: #b5b09f; color: #b5b09f; }
	.prompt { background: #1d201a; }
	.prompt-head { background: #2b2d24; }
	.prompt pre { color: #dedacc; }
	.prompt-foot code { color: #d9bd96; }
	.client-list li:hover { background: #2a2c23; }
	.statement p, .feature-text p, .connect-copy > p, .clients-intro p, .tech-copy p { color: #c0beb2; }
</style>
