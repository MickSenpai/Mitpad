<script lang="ts">
    import { onMount, tick } from 'svelte';
    import type { Clerk as ClerkClient } from '@clerk/clerk-js';
    import { ui } from '@clerk/ui';
    import { ConvexHttpClient } from 'convex/browser';
    import type { Id } from '../../convex/_generated/dataModel';
    import { PUBLIC_CONVEX_URL } from '$env/static/public';
    import { api } from '../../convex/_generated/api';

    type Status = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
    const statuses: { id: Status; label: string }[] = [
        { id: 'backlog', label: 'Pendiente' }, { id: 'todo', label: 'Por hacer' }, { id: 'in_progress', label: 'En curso' },
        { id: 'review', label: 'Revisión' }, { id: 'blocked', label: 'Bloqueado' }, { id: 'done', label: 'Hecho' },
    ];
    let clerk: ClerkClient | null = null;
    let client: ConvexHttpClient | null = null;
    let signInNode: HTMLDivElement;
    let signInMounted = false;
    let showProfile = false;
    let profileNode: HTMLDivElement;
    let profileMounted = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval>;
    let connected = false, busy = false, uploading = false;
    let error = '', notice = '', lastSync: number | null = null;
    let projects: any[] = [], tasks: any[] = [], agents: any[] = [], events: any[] = [], notes: any[] = [], images: any[] = [];
    let selectedProject: Id<'projects'> | '' = '', selectedNote = '';
    let taskStatusFilter = 'all', agentFilter = 'all', priorityFilter = 'all', activityFilter = 'all';
    let search = '', newProjectName = '', newProjectDescription = '', newTaskTitle = '', newTaskDescription = '';
    let noteTitle = '', noteContent = '', noteProject: Id<'projects'> | '' = '', noteStatus: 'open' | 'attended' = 'open';
    let section: 'monitor' | 'notes' | 'images' = 'monitor';
    let graphFile: HTMLInputElement;
    $: visibleTasks = tasks.filter(t => (!selectedProject || t.projectId === selectedProject) && (taskStatusFilter === 'all' || t.status === taskStatusFilter) && (agentFilter === 'all' || t.assigneeAgentId === agentFilter || agentFilter === 'unassigned' && !t.assigneeAgentId) && (priorityFilter === 'all' || t.priority === priorityFilter) && (!search.trim() || `${t.title} ${t.description}`.toLowerCase().includes(search.trim().toLowerCase())));
    $: selectedProjectName = projects.find(p => p.id === selectedProject)?.name ?? 'Todos los proyectos';
    $: currentNote = notes.find(n => n.id === selectedNote);
    $: userEmail = clerk?.user?.primaryEmailAddress?.emailAddress ?? 'Cuenta Clerk';

    onMount(() => {
        if (!PUBLIC_CONVEX_URL || !import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) { error = 'Falta configurar PUBLIC_CONVEX_URL o VITE_CLERK_PUBLISHABLE_KEY para la web.'; return; }
        client = new ConvexHttpClient(PUBLIC_CONVEX_URL);
        void initialize();
        timer = setInterval(() => { if (connected && document.visibilityState === 'visible' && !busy) void refresh(true); }, 300_000);
        return () => { clearInterval(timer); unsubscribe?.(); if (clerk && signInMounted && signInNode) clerk.unmountSignIn(signInNode); if (clerk && profileMounted && profileNode) clerk.unmountUserProfile(profileNode); };
    });

    async function initialize() {
        try {
            const { Clerk } = await import('@clerk/clerk-js');
            clerk = new Clerk(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
            await clerk.load({ ui });
            unsubscribe = clerk.addListener(() => { void syncIdentity(); });
            await syncIdentity();
        } catch (e) { error = `No se pudo iniciar Clerk: ${message(e)}`; }
    }

    async function syncIdentity() {
        if (!clerk || !client) return;
        if (!clerk.session) {
            client.clearAuth(); connected = false; clearData();
            await tick();
            if (signInNode && !signInMounted) {
                clerk.mountSignIn(signInNode, { routing: 'hash', signUpUrl: '#/sign-up', appearance: { variables: { colorPrimary: '#80dfc5', colorBackground: '#151d26', colorText: '#e6edf3', colorInputBackground: '#10161e', colorInputText: '#e6edf3' } } });
                signInMounted = true;
            }
            return;
        }
        try {
            const jwt = await clerk.session.getToken();
            if (!jwt) throw new Error('Clerk no entregó un token de sesión.');
            client.setAuth(jwt);
            await client.mutation(api.web.asegurarWorkspace, {});
            if (signInMounted && signInNode) { clerk.unmountSignIn(signInNode); signInMounted = false; }
            await refresh(true);
        } catch (e) { connected = false; error = `No se autorizó el acceso al workspace: ${message(e)}`; }
    }

    async function refresh(quiet = false) {
        if (!client || busy) return;
        busy = true; if (!quiet) { error = ''; notice = ''; }
        try {
            const data: any = await client.query(api.web.dashboard, {});
            projects = data.projects; tasks = data.tasks; agents = data.agents; events = data.events; notes = data.notes; images = data.images;
            if (selectedProject && !projects.some(p => p.id === selectedProject)) selectedProject = '';
            if (selectedNote && !notes.some(n => n.id === selectedNote)) selectedNote = '';
            connected = true; lastSync = Date.now(); if (!quiet) notice = 'Workspace actualizado desde Convex.';
        } catch (e) { connected = false; error = `Falló la actualización del workspace: ${message(e)}`; }
        finally { busy = false; }
    }

    function clearData() { projects = []; tasks = []; agents = []; events = []; notes = []; images = []; lastSync = null; selectedProject = ''; selectedNote = ''; }
    async function createProject() {
        if (!client || !newProjectName.trim()) return; busy = true;
        try { const p: any = await client.mutation(api.web.crearProyecto, { name: newProjectName.trim(), description: newProjectDescription.trim() }); newProjectName = ''; newProjectDescription = ''; selectedProject = p.id; await refresh(true); notice = 'Proyecto creado.'; }
        catch (e) { error = `No se pudo crear el proyecto: ${message(e)}`; } finally { busy = false; }
    }
    async function createTask() {
        if (!client || !selectedProject || !newTaskTitle.trim()) return; busy = true;
        try { await client.mutation(api.web.crearTarea, { projectId: selectedProject, title: newTaskTitle.trim(), description: newTaskDescription.trim() }); newTaskTitle = ''; newTaskDescription = ''; await refresh(true); notice = 'Tarea agregada.'; }
        catch (e) { error = `No se pudo agregar la tarea: ${message(e)}`; } finally { busy = false; }
    }
    async function moveTask(task: any, next: Status) {
        if (!client || task.status === next) return;
        try { await client.mutation(api.web.actualizarTarea, { taskId: task.id, status: next }); tasks = tasks.map(t => t.id === task.id ? { ...t, status: next } : t); }
        catch (e) { error = `No se pudo actualizar la tarea: ${message(e)}`; }
    }
    function chooseNote(note?: any) { selectedNote = note?.id ?? ''; noteTitle = note?.title ?? ''; noteContent = note?.content ?? ''; noteProject = note?.projectId ?? ''; noteStatus = note?.status ?? 'open'; }
    async function saveNote() {
        if (!client) return; busy = true;
        try { const id = await client.mutation(api.web.guardarNota, { id: selectedNote || undefined, title: noteTitle, content: noteContent, projectId: noteProject || null, status: noteStatus }); selectedNote = id; await refresh(true); notice = 'Nota guardada en Convex.'; }
        catch (e) { error = `No se pudo guardar la nota: ${message(e)}`; } finally { busy = false; }
    }
    async function uploadImage(file?: File) {
        if (!client || !selectedProject || !file) return;
        const acceptedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!acceptedTypes.includes(file.type)) { error = 'Usa una imagen JPEG, PNG, WebP o GIF.'; return; }
        if (file.size > 10 * 1024 * 1024) { error = 'La imagen supera el límite de 10 MB.'; return; }
        uploading = true; error = '';
        try {
            const url = await client.mutation(api.web.crearUrlSubidaImagen, { projectId: selectedProject });
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
            if (!response.ok) throw new Error(`Carga fallida (${response.status}).`);
            const { storageId } = await response.json();
            await client.mutation(api.web.registrarImagen, { projectId: selectedProject, storageId, filename: file.name });
            await refresh(true); notice = 'Imagen vinculada al proyecto.';
        } catch (e) { error = `No se pudo cargar la imagen: ${message(e)}`; } finally { uploading = false; if (graphFile) graphFile.value = ''; }
    }
    async function deleteImage(image: any) { if (!client) return; try { await client.mutation(api.web.borrarImagen, { imageId: image.id }); images = images.filter(i => i.id !== image.id); } catch (e) { error = `No se pudo borrar la imagen: ${message(e)}`; } }
    async function signOut() { await clerk?.signOut(); }
    async function openProfile() {
        showProfile = true;
        await tick();
        if (clerk && profileNode && !profileMounted) {
            clerk.mountUserProfile(profileNode);
            profileMounted = true;
        }
    }
    function closeProfile() {
        if (clerk && profileMounted && profileNode) clerk.unmountUserProfile(profileNode);
        profileMounted = false;
        showProfile = false;
    }
    function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
    function date(value: number) { return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(value); }
</script>

<main class="web-shell">
    <header class="header"><a class="brand" href="/">M <span>mitpad <small>AGENT WORKBENCH · WEB</small></span></a><div class="header-actions">{#if connected}<span class="sync-state"><i></i> Conectado · actualización cada 5 min</span><span class="user-email">{userEmail}</span><button class="profile-button" on:click={() => void openProfile()}>Perfil</button><button on:click={() => void refresh()} disabled={busy}>{busy ? 'Actualizando…' : 'Actualizar'}</button><button class="sign-out" on:click={() => void signOut()}>Salir</button>{/if}</div></header>
    {#if error}<div class="alert error">{error}</div>{/if}{#if notice}<div class="alert notice">{notice}</div>{/if}
    {#if !connected}<section class="connect-card"><div class="eyebrow">ACCESO SEGURO · CLERK</div><h1>Entra a tu workspace</h1><p>Inicia sesión con tu cuenta. Convex valida la sesión y limita el acceso al correo configurado para Mitpad.</p>{#if clerk?.session}<div class="signed-in">Sesión: {userEmail}<button class="sign-out" on:click={() => void signOut()}>Cerrar sesión</button></div>{:else}<div class="clerk-widget" bind:this={signInNode}></div>{/if}<small>Activa GitHub como proveedor en Clerk Dashboard para mostrar “Continue with GitHub”.</small></section>
    {:else}<section class="dashboard"><div class="intro"><div><div class="eyebrow">SUPERVISIÓN DEL WORKSPACE</div><h1>Proyectos y agentes, de un vistazo</h1><p>Monitorea cambios, notas y archivos desde Convex.</p></div><div class="last-sync"><span>Última consulta</span><strong>{lastSync ? date(lastSync) : 'Conectando…'}</strong><small>{projects.length} proyectos · {tasks.length} tareas · {agents.length} agentes</small></div></div>
        <nav class="tabs"><button class:active={section === 'monitor'} on:click={() => section = 'monitor'}>Monitoreo</button><button class:active={section === 'notes'} on:click={() => section = 'notes'}>Notas <small>{notes.length}</small></button><button class:active={section === 'images'} on:click={() => section = 'images'}>Imágenes <small>{images.length}</small></button></nav>
        {#if section === 'monitor'}
            <div class="summary-grid"><article><span>Proyectos</span><strong>{projects.length}</strong><small>{projects.filter(p => p.status === 'active').length} activos</small></article><article><span>Tareas abiertas</span><strong>{tasks.filter(t => t.status !== 'done').length}</strong><small>{tasks.filter(t => t.status === 'blocked').length} bloqueadas</small></article><article><span>Agentes</span><strong>{agents.length}</strong><small>{agents.filter(a => a.active).length} activos</small></article><article><span>Actividad</span><strong>{events.length}</strong><small>eventos recientes</small></article></div>
            <div class="workspace-grid"><section class="work-panel"><div class="panel-head"><div><div class="eyebrow">SEGUIMIENTO</div><h2>{selectedProjectName}</h2></div><select aria-label="Filtrar por proyecto" bind:value={selectedProject}><option value="">Todos los proyectos</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select></div>
                <div class="filters"><select aria-label="Filtrar por estado" bind:value={taskStatusFilter}><option value="all">Todos los estados</option>{#each statuses as s}<option value={s.id}>{s.label}</option>{/each}</select><select aria-label="Filtrar por agente" bind:value={agentFilter}><option value="all">Todos los agentes</option><option value="unassigned">Sin asignar</option>{#each agents as a (a.id)}<option value={a.id}>{a.name}</option>{/each}</select><select aria-label="Filtrar por prioridad" bind:value={priorityFilter}><option value="all">Todas las prioridades</option>{#each ['urgent','high','medium','low'] as p}<option value={p}>{p}</option>{/each}</select><input bind:value={search} placeholder="Buscar tareas…" aria-label="Buscar tareas" /></div>
                {#if selectedProject}<form class="task-create" on:submit|preventDefault={createTask}><input bind:value={newTaskTitle} placeholder="Nueva tarea…" required /><input bind:value={newTaskDescription} placeholder="Descripción opcional" /><button disabled={busy}>＋ Agregar tarea</button></form>{/if}
                {#if visibleTasks.length}<div class="task-list">{#each visibleTasks as t (t.id)}<article class="task"><div class="task-main"><span class="priority" class:urgent={t.priority === 'urgent'}></span><div><strong>{t.title}</strong><p>{t.description || 'Sin descripción'}</p><small>{projects.find(p => p.id === t.projectId)?.name ?? 'Proyecto'} · {t.assigneeAgentId ? agents.find(a => a.id === t.assigneeAgentId)?.name ?? 'Agente' : t.createdByType === 'agent' ? 'Creada por agente' : 'Sin asignar'}</small></div></div><select aria-label={`Estado de ${t.title}`} value={t.status} on:change={e => void moveTask(t, (e.currentTarget as HTMLSelectElement).value as Status)}>{#each statuses as s}<option value={s.id}>{s.label}</option>{/each}</select></article>{/each}</div>{:else}<div class="empty">No hay tareas con estos filtros.</div>{/if}
                <form class="create-project" on:submit|preventDefault={createProject}><strong>＋ Nuevo proyecto</strong><input bind:value={newProjectName} placeholder="Nombre" required /><input bind:value={newProjectDescription} placeholder="Objetivo o contexto" /><button disabled={busy}>Crear</button></form>
            </section><aside class="side-column"><section class="side-panel"><div class="eyebrow">AGENTES</div><h2>Equipo de trabajo</h2>{#each agents as a (a.id)}<div class="agent"><span class:online={a.active}></span><div><strong>{a.name}</strong><small>{a.model || a.clientType} · {a.active ? 'Activo' : 'Inactivo'}</small></div>{#if a.lastSeenAt}<time>{date(a.lastSeenAt)}</time>{/if}</div>{/each}{#if !agents.length}<p class="empty-small">Aún no hay agentes registrados.</p>{/if}</section><section class="side-panel"><div class="eyebrow">ACTIVIDAD</div><h2>Últimos movimientos</h2><select class="activity-filter" aria-label="Filtrar actividad" bind:value={activityFilter}><option value="all">Todos</option><option value="agent">Agentes</option><option value="human">Personas</option></select><div class="events">{#each events.filter(e => activityFilter === 'all' || e.actorType === activityFilter).slice(0, 12) as e (e.id)}<article><i class:agent-event={e.actorType === 'agent'}></i><div><strong>{e.summary}</strong><small>{e.actorType === 'agent' ? `Agente ${e.actorId}` : 'Piloto'} · {date(e.createdAt)}</small></div></article>{/each}</div></section></aside></div>
        {:else if section === 'notes'}<div class="content-grid"><section class="side-panel note-list"><div class="eyebrow">MEMORIA</div><h2>Notas conservadas</h2>{#each notes as n (n.id)}<button class="note-row" class:selected={selectedNote === n.id} on:click={() => chooseNote(n)}><strong>{n.title || 'Sin título'}</strong><small>{n.status === 'attended' ? 'Atendida' : 'Abierta'} · {projects.find(p => p.id === n.projectId)?.name ?? 'Sin proyecto'}</small></button>{/each}<button class="new-note" on:click={() => chooseNote()}>＋ Nueva nota</button></section><section class="work-panel note-editor"><div class="eyebrow">{selectedNote ? 'EDITAR NOTA' : 'NUEVA NOTA'}</div><input class="note-title" bind:value={noteTitle} placeholder="Título" /><div class="note-meta"><select aria-label="Proyecto asociado" bind:value={noteProject}><option value="">Sin proyecto</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select><select aria-label="Estado de nota" bind:value={noteStatus}><option value="open">Abierta</option><option value="attended">Atendida</option></select></div><textarea bind:value={noteContent} placeholder="Escribe contexto útil para ti y tus agentes…"></textarea><button class="primary" on:click={() => void saveNote()} disabled={busy}>Guardar nota</button></section></div>
        {:else}<section class="work-panel image-library"><div class="panel-head"><div><div class="eyebrow">ARCHIVOS DEL PROYECTO</div><h2>Imágenes</h2></div><select aria-label="Proyecto para imágenes" bind:value={selectedProject}><option value="">Elige un proyecto</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select></div><p>Las imágenes se guardan en Convex Storage y quedan vinculadas al proyecto seleccionado. Límite: 10 MB por archivo.</p><label class="upload">{uploading ? 'Subiendo…' : '＋ Subir imagen'}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={!selectedProject || uploading} on:change={e => void uploadImage((e.currentTarget as HTMLInputElement).files?.[0])} /></label><div class="image-grid">{#each images.filter(i => !selectedProject || i.projectId === selectedProject) as image (image.id)}<article><a href={image.url ?? '#'} target="_blank" rel="noreferrer"><img src={image.url ?? ''} alt={image.filename} loading="lazy" /></a><div><strong>{image.filename}</strong><small>{projects.find(p => p.id === image.projectId)?.name ?? 'Proyecto'} · {(image.size / 1024).toFixed(0)} KB</small><button on:click={() => void deleteImage(image)}>Quitar</button></div></article>{/each}</div>{#if !images.length}<div class="empty">Todavía no hay imágenes.</div>{/if}</section>{/if}
    </section>{/if}
    {#if showProfile}<div class="profile-backdrop" role="presentation"><dialog open class="profile-dialog" aria-label="Perfil de usuario"><header><div><div class="eyebrow">CUENTA CLERK</div><h2>Mi perfil</h2></div><button class="sign-out" on:click={closeProfile}>Cerrar</button></header><div class="profile-mount" bind:this={profileNode}></div></dialog></div>{/if}
</main>

<style>
    :global(*){box-sizing:border-box}:global(body){margin:0;background:#0e1117;color:#e6edf3;font:14px Inter,ui-sans-serif,system-ui,sans-serif}.web-shell{min-height:100vh;background:radial-gradient(ellipse at 52% -15%,#1c2b36 0,transparent 52%),#0e1117}.header{height:68px;padding:0 clamp(18px,4vw,64px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #242e39;background:#0e1117dd}.brand{display:flex;align-items:center;gap:11px;color:#a4f1dc;text-decoration:none;font-weight:800;font-size:18px}.brand>span{color:#edf4f7}.brand small{display:block;color:#748394;font-size:9px;letter-spacing:1.3px;margin-top:3px}.header-actions{display:flex;align-items:center;gap:10px}.header button,.primary,.task-create button,.create-project button,.new-note{color:#101917;background:#95e8d3;border:0;border-radius:7px;padding:9px 13px;font-weight:700;cursor:pointer}.header button:disabled,.primary:disabled{opacity:.5}.header button.sign-out,.signed-in button{color:#b8c5d2;background:#1d2731}.user-email{font-size:10px;color:#9eabb8}.signed-in{display:flex;align-items:center;justify-content:space-between;margin-top:18px;color:#b8c5d2;font-size:11px}.signed-in button{padding:8px 10px;border:0;border-radius:6px;cursor:pointer}.sync-state{color:#a8bcba;font-size:11px}.sync-state i,.agent>span{display:inline-block;width:7px;height:7px;background:#74d5ad;border-radius:50%;margin-right:6px}.alert{margin:14px auto 0;width:min(1440px,92vw);padding:10px 13px;border-radius:7px;font-size:12px}.error{color:#ffb9b1;background:#352124;border:1px solid #694147}.notice{color:#a8ead8;background:#192d29;border:1px solid #31554c}.dashboard{width:min(1440px,92vw);margin:34px auto 70px}.intro{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:22px}.eyebrow{font-size:9px;letter-spacing:1.4px;font-weight:800;color:#7e9aaa}.intro h1,.connect-card h1{font-size:27px;letter-spacing:-.8px;margin:7px 0}.intro p,.connect-card>p{color:#8998a8;margin:0;font-size:12px}.last-sync{display:grid;gap:5px;text-align:right;color:#748394;font-size:10px}.last-sync strong{color:#d4e4e9;font-size:12px}.summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin:16px 0}.summary-grid article,.work-panel,.side-panel{border:1px solid #293440;background:rgba(20,27,35,.92);border-radius:10px}.summary-grid article{padding:16px}.summary-grid span,.summary-grid small{display:block;color:#8797a7;font-size:10px}.summary-grid strong{display:block;font-size:27px;margin:8px 0 3px}.summary-grid small{color:#78cdb5}.tabs{display:flex;gap:6px;border-bottom:1px solid #293440}.tabs button{padding:11px 14px;color:#a7b5c2;background:transparent;border:0;border-bottom:2px solid transparent;cursor:pointer}.tabs button.active{color:#a4f1dc;border-color:#80dfc5}.tabs small{color:#8090a0}.workspace-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(300px,.85fr);gap:14px;align-items:start}.work-panel{padding:18px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.panel-head h2,.side-panel h2{font-size:15px;margin:5px 0 0}.panel-head select,.task select,.filters select,.filters input,.task-create input,.create-project input,.note-meta select,.image-library select{color:#d9e2eb;background:#10161e;border:1px solid #303b49;border-radius:6px;padding:9px}.filters{display:flex;gap:8px;margin:15px 0 10px;flex-wrap:wrap}.filters input{flex:1;min-width:130px}.task-create{display:flex;gap:7px;margin:10px 0 13px;padding:12px 0;border-top:1px solid #27313b;border-bottom:1px solid #27313b}.task-create input:first-child{flex:1;min-width:100px}.task-create input:nth-child(2){flex:1;min-width:100px}.task-create button,.create-project button{padding:8px 10px;font-size:10px;white-space:nowrap}.task-list{display:grid}.task{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 2px;border-bottom:1px solid #27313b}.task-main{display:flex;align-items:flex-start;gap:10px;min-width:0}.task-main>div{min-width:0}.task strong{font-size:12px}.task p{font-size:10px;color:#8b99a8;margin:5px 0;overflow-wrap:anywhere}.task small{font-size:9px;color:#667687}.priority{width:7px;height:7px;flex:none;margin-top:4px;border-radius:50%;background:#81b8f0}.priority.urgent{background:#ff8778}.task select{min-width:115px;font-size:10px}.create-project{display:flex;gap:7px;align-items:center;margin-top:15px;padding-top:14px;border-top:1px solid #27313b}.create-project strong{font-size:10px;white-space:nowrap}.create-project input{min-width:80px;flex:1}.side-column{display:grid;gap:13px}.side-panel{padding:16px}.agent{display:flex;align-items:center;gap:8px;padding:11px 0;border-bottom:1px solid #26303a}.agent:last-of-type{border:0}.agent>span{width:8px;height:8px;background:#596775;flex:none}.agent>span.online{background:#71d3ab}.agent>div{display:grid;gap:4px;flex:1}.agent strong{font-size:11px}.agent small,.agent time{font-size:9px;color:#8392a2}.agent time{white-space:nowrap}.events{display:grid;margin-top:8px}.events article{display:flex;gap:9px;padding:9px 0;border-bottom:1px solid #26303a}.events i{width:7px;height:7px;flex:none;margin-top:4px;border-radius:50%;background:#8ca8c5}.events i.agent-event{background:#bb91ef}.events article div{display:grid;gap:5px}.events strong{font-size:10px;line-height:1.4}.events small{font-size:9px;color:#7d8b9a}.activity-filter{margin-top:10px;color:#d9e2eb;background:#10161e;border:1px solid #303b49;border-radius:6px;padding:7px}.empty,.empty-small{color:#778696;font-size:11px;padding:24px 8px;text-align:center}.empty-small{padding:15px 0}.connect-card{width:min(480px,calc(100% - 32px));margin:9vh auto;padding:28px;border:1px solid #2b3743;border-radius:14px;background:#141b23;box-shadow:0 20px 80px #0005}.connect-card h1{font-size:25px}.connect-card small{display:block;margin-top:16px;color:#788899;line-height:1.7;font-size:10px}.clerk-widget{margin-top:20px}.content-grid{display:grid;grid-template-columns:minmax(240px,.75fr) minmax(0,1.5fr);gap:14px;margin-top:16px}.note-list{align-self:start}.note-row{display:grid;width:100%;gap:6px;padding:11px 7px;text-align:left;color:#dbe4ec;background:none;border:0;border-bottom:1px solid #26313c;cursor:pointer}.note-row.selected{background:#1c2b35}.note-row small{color:#8393a3;font-size:10px}.new-note{margin-top:12px}.note-editor{display:grid;gap:12px;align-content:start}.note-title,.note-editor textarea{color:#e6edf3;background:#10161e;border:1px solid #303b49;border-radius:7px;padding:12px}.note-meta{display:flex;gap:8px}.note-editor textarea{min-height:48vh;resize:vertical;line-height:1.6}.primary{justify-self:end}.image-library{margin-top:16px}.image-library>p{color:#8b99a8;font-size:11px}.upload{display:inline-block;margin:9px 0 16px;padding:10px 13px;background:#95e8d3;color:#101917;border-radius:7px;font-weight:700;font-size:11px;cursor:pointer}.upload input{display:none}.image-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.image-grid article{overflow:hidden;border:1px solid #2b3743;border-radius:8px;background:#111820}.image-grid img{width:100%;height:145px;object-fit:cover;background:#0b0f14}.image-grid article>div{display:grid;gap:5px;padding:9px}.image-grid strong{font-size:10px;overflow-wrap:anywhere}.image-grid small{color:#8090a0;font-size:9px}.image-grid button{justify-self:start;color:#ffb9b1;background:none;border:0;padding:3px 0;cursor:pointer;font-size:10px}@media(max-width:950px){.workspace-grid{grid-template-columns:1fr}.summary-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:680px){.header{padding:0 14px}.sync-state,.user-email{display:none}.dashboard{margin-top:22px}.intro{align-items:flex-start;flex-direction:column}.last-sync{text-align:left}.task-create{flex-wrap:wrap}.task-create input{flex-basis:40%}.create-project{flex-wrap:wrap}.create-project strong{width:100%}.task{align-items:flex-start;flex-direction:column}.task select{margin-left:17px}.agent time{display:none}.content-grid{grid-template-columns:1fr}.note-editor textarea{min-height:36vh}.image-library .panel-head{align-items:flex-start;flex-direction:column}}

        .profile-button { color:#b9d8d3!important; background:#1d2731!important; }.profile-backdrop { position:fixed; inset:0; z-index:60; display:grid; place-items:center; padding:20px; background:#05080ddd; }.profile-dialog { width:min(940px,100%); max-height:92vh; overflow:auto; padding:0; color:#e6edf3; border:1px solid #34414e; border-radius:14px; background:#111820; box-shadow:0 24px 90px #0009; }.profile-dialog>header { position:sticky; top:0; z-index:1; display:flex; justify-content:space-between; align-items:center; padding:16px 20px; background:#111820; border-bottom:1px solid #293541; }.profile-dialog h2 { margin:4px 0 0; font-size:17px; }.profile-mount { min-height:520px; padding:14px; }

</style>
