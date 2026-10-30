<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { mountAuthBridge, type AuthSession } from '$lib/ConvexAuthIsland';
    import { ConvexHttpClient } from 'convex/browser';
    import type { Id } from '../../convex/_generated/dataModel';
    import { PUBLIC_CONVEX_URL } from '$env/static/public';
    import { api } from '../../convex/_generated/api';
    import ThreeDGraph from '$lib/ThreeDGraph.svelte';
    import AccountProfile from '$lib/AccountProfile.svelte';
    import PrivateVault from '$lib/PrivateVault.svelte';
    import { isMissingLegacyWorkspaceLink } from '$lib/convexCompat';

    const MCP_ENDPOINT = 'https://mitpad.onrender.com/mcp';

    type Status = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
    const statuses: { id: Status; label: string }[] = [
        { id: 'backlog', label: 'Pendiente' }, { id: 'todo', label: 'Por hacer' }, { id: 'in_progress', label: 'En curso' },
        { id: 'review', label: 'Revisión' }, { id: 'blocked', label: 'Bloqueado' }, { id: 'done', label: 'Hecho' },
    ];
    let client: ConvexHttpClient | null = null;
    let authNode: HTMLDivElement;
    let authRoot: (() => void) | null = null;
    let authSignOut: (() => Promise<void>) | null = null;
    let fetchAuthToken: AuthSession['fetchAccessToken'] | null = null;
    let lastAuthToken = '';
    let userEmail = 'Cuenta';
    let showProfile = false;
    let timer: ReturnType<typeof setInterval>;
    let connected = false, busy = false, uploading = false;
    let error = '', notice = '', lastSync: number | null = null;
    let projects: any[] = [], projectLinks: any[] = [], knowledge: any[] = [], tasks: any[] = [], agents: any[] = [], events: any[] = [], notes: any[] = [], images: any[] = [];
    let selectedProject: Id<'projects'> | '' = '', selectedNote = '';
    let taskStatusFilter = 'all', agentFilter = 'all', priorityFilter = 'all', activityFilter = 'all';
    let search = '', newProjectName = '', newProjectDescription = '', newTaskTitle = '', newTaskDescription = '';
    let editingProject: string = '', editProjectName = '', editProjectDescription = '';
    let relationSource: Id<'projects'> | '' = '', relationTarget: Id<'projects'> | '' = '', relationDescription = '';
    let remoteAgentName = 'OpenCode', remoteAgentModel = 'auto', remoteAgentProvider = 'auto', remoteAgentKey = '';
    let remoteAgentClient = 'codex', remoteAgentCheck = '', remoteAgentChecking = false;
    let editingAgent: any = null, editAgentName = '', editAgentModel = '', editAgentProvider = '', editAgentClient = '';
    let selectedTask: any = null, taskComments: any[] = [], taskComment = '', taskCommentKind = 'message';
    let noteTitle = '', noteContent = '', noteProject: Id<'projects'> | '' = '', noteStatus: 'open' | 'attended' = 'open';
    let section: 'projects' | 'board' | 'notes' | 'images' | 'activity' | 'agents' | 'graph' | 'secrets' = 'projects';
    let selectedGraphNode: any = null;
    let graphFile: HTMLInputElement;
    $: visibleTasks = tasks.filter(t => (!selectedProject || t.projectId === selectedProject) && (taskStatusFilter === 'all' || t.status === taskStatusFilter) && (agentFilter === 'all' || t.assigneeAgentId === agentFilter || agentFilter === 'unassigned' && !t.assigneeAgentId) && (priorityFilter === 'all' || t.priority === priorityFilter) && (!search.trim() || `${t.title} ${t.description}`.toLowerCase().includes(search.trim().toLowerCase())));
    $: selectedProjectName = projects.find(p => p.id === selectedProject)?.name ?? 'Todos los proyectos';
    $: currentNote = notes.find(n => n.id === selectedNote);
    $: graphNodes = (() => {
        const visibleProjects = projects.filter(p => !selectedProject || p.id === selectedProject);
        const overviewRadius = Math.max(360, visibleProjects.length * 135);
        const angleFor = (i: number, offset = 0) => i * 2.399963 + offset;
        const projectNodes = visibleProjects.map((p, i) => {
            const angle = selectedProject ? 0 : -Math.PI / 2 + (i / Math.max(visibleProjects.length, 1)) * Math.PI * 2;
            const x = selectedProject ? 0 : Math.cos(angle) * overviewRadius;
            const z = selectedProject ? 0 : Math.sin(angle) * overviewRadius;
            return { id: p.id, label: p.name, kind: 'project' as const, projectId: p.id, x, y: 0, z };
        });
        if (!selectedProject || !visibleProjects.length) return projectNodes;
        const projectId = visibleProjects[0].id;
        const taskNodes = tasks.filter(t => t.projectId === projectId).map((t, i) => {
            const angle = angleFor(i);
            const radius = 105 + Math.floor(i / 12) * 28;
            return { id: `task:${t.id}`, label: t.title, kind: 'task' as const, projectId, x: Math.cos(angle) * radius, y: 34 + (i % 5 - 2) * 20, z: Math.sin(angle) * radius, status: t.status };
        });
        const knowledgeNodes = knowledge.filter(k => k.projectId === projectId).map((k, i) => {
            const angle = angleFor(i, 0.8);
            const radius = 205 + Math.floor(i / 16) * 32;
            return { id: `knowledge:${k.id}`, label: k.title, kind: 'knowledge' as const, projectId, x: Math.cos(angle) * radius, y: -34 + (i % 5 - 2) * 20, z: Math.sin(angle) * radius, knowledgeKind: k.kind, summary: k.summary, source: k.source, tags: k.tags };
        });
        return [...projectNodes, ...taskNodes, ...knowledgeNodes];
    })();
    $: graphLinks = projectLinks.map(link => ({ source_project_id: link.sourceProjectId, target_project_id: link.targetProjectId, description: link.description }));

    onMount(() => {
        if (!PUBLIC_CONVEX_URL) { error = 'Falta configurar PUBLIC_CONVEX_URL para la web.'; return; }
        client = new ConvexHttpClient(PUBLIC_CONVEX_URL, { fetch: async (input, init) => {
            const send = async (token: string | null) => {
                const headers = new Headers(init?.headers);
                if (token) headers.set('Authorization', `Bearer ${token}`);
                else headers.delete('Authorization');
                return fetch(input, { ...init, headers });
            };
            const token = await fetchAuthToken?.({ forceRefreshToken: false }) ?? null;
            const response = await send(token);
            let authRejected = response.status === 401;
            if (!authRejected) {
                try {
                    const payload = await response.clone().json();
                    authRejected = payload?.status === 'error' && /unauthenticated|not authenticated|invalid auth token|token.*expired/i.test(String(payload.errorMessage ?? ''));
                } catch { /* Some Convex endpoints return non-JSON errors. */ }
            }
            if (!authRejected) return response;
            const refreshedToken = await fetchAuthToken?.({ forceRefreshToken: true }) ?? null;
            return refreshedToken && refreshedToken !== token ? send(refreshedToken) : response;
        } });
        authRoot = mountAuthBridge(authNode, PUBLIC_CONVEX_URL, (session) => handleSession(session));
        const refreshWhenActive = () => {
            if (lastAuthToken && document.visibilityState === 'visible' && navigator.onLine && !busy) void refresh(true);
        };
        timer = setInterval(refreshWhenActive, 300_000);
        document.addEventListener('visibilitychange', refreshWhenActive);
        window.addEventListener('online', refreshWhenActive);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refreshWhenActive); window.removeEventListener('online', refreshWhenActive); authRoot?.(); };
    });

    async function handleSession(session: AuthSession) {
        authSignOut = session.signOut;
        fetchAuthToken = session.fetchAccessToken;
        if (!client) return;
        if (!session.token) {
            lastAuthToken = ''; fetchAuthToken = null; client.clearAuth(); connected = false; clearData(); userEmail = 'Cuenta'; return;
        }
        userEmail = session.email ?? 'Cuenta';
        client.setAuth(session.token);
        if (lastAuthToken === session.token && connected) return;
        lastAuthToken = session.token;
        try {
            await client.mutation(api.web.asegurarWorkspace, {});
            let migrationPending = false;
            try {
                const migration: any = await client.mutation(api.web.vincularDatosAnteriores, {});
                if (migration.linked) notice = `Workspace anterior vinculado. Sus notas se están incorporando en segundo plano; ${migration.projects} proyectos disponibles.`;
            } catch (migrationError) {
                if (!isMissingLegacyWorkspaceLink(migrationError)) throw migrationError;
                migrationPending = true;
            }
            await refresh(true);
            if (migrationPending) notice = 'Sesión iniciada. La conexión con los datos anteriores está pendiente de actualizar en el servidor; tus datos no se borraron.';
        } catch (e) { connected = false; error = `No se autorizó el acceso al workspace: ${message(e)}`; }
    }

    async function refresh(quiet = false) {
        if (!client || busy) return;
        busy = true; if (!quiet) { error = ''; notice = ''; }
        try {
            const data: any = await client.query(api.web.dashboard, {});
            projects = data.projects; projectLinks = data.projectLinks; knowledge = data.knowledge; tasks = data.tasks; agents = data.agents; events = data.events; notes = data.notes; images = data.images;
            if (selectedProject && !projects.some(p => p.id === selectedProject)) selectedProject = '';
            if (selectedNote && !notes.some(n => n.id === selectedNote)) selectedNote = '';
            connected = true; lastSync = Date.now(); if (!quiet) notice = 'Workspace actualizado desde Convex.';
        } catch (e) {
            connected = false;
            const detail = message(e);
            error = /\bnot found\b|\b404\b/i.test(detail)
                ? 'El servidor respondió “Not found”. Puede que la web y el backend estén en versiones distintas. Reintenta; si persiste, la sesión puede necesitar volver a iniciarse.'
                : `Falló la actualización del workspace: ${detail}`;
        }
        finally { busy = false; }
    }

    function clearData() { projects = []; projectLinks = []; knowledge = []; tasks = []; agents = []; events = []; notes = []; images = []; lastSync = null; selectedProject = ''; selectedNote = ''; selectedTask = null; taskComments = []; }
    async function createProject() {
        if (!client || !newProjectName.trim()) return; busy = true;
        try { const p: any = await client.mutation(api.web.crearProyecto, { name: newProjectName.trim(), description: newProjectDescription.trim() }); newProjectName = ''; newProjectDescription = ''; selectedProject = p.id; await refresh(true); notice = 'Proyecto creado.'; }
        catch (e) { error = `No se pudo crear el proyecto: ${message(e)}`; } finally { busy = false; }
    }
    function startProjectEdit(project: any) { editingProject = project.id; editProjectName = project.name; editProjectDescription = project.description; }
    async function saveProjectEdit() {
        if (!client || !editingProject) return;
        try { await client.mutation(api.web.editarProyecto, { projectId: editingProject as Id<'projects'>, name: editProjectName, description: editProjectDescription }); editingProject = ''; await refresh(true); notice = 'Proyecto actualizado.'; }
        catch (e) { error = `No se pudo editar el proyecto: ${message(e)}`; }
    }
    async function deleteProject(project: any) {
        if (!client || !window.confirm(`¿Eliminar permanentemente “${project.name}”? Se borrarán sus tareas, comentarios, contexto y relaciones. Las notas e imágenes se conservarán sin vínculo al proyecto.`)) return;
        busy = true;
        try {
            await client.mutation(api.web.borrarProyecto, { projectId: project.id });
            if (selectedProject === project.id) selectedProject = '';
            if (editingProject === project.id) editingProject = '';
            projects = projects.filter(item => item.id !== project.id);
            tasks = tasks.filter(item => item.projectId !== project.id);
            knowledge = knowledge.filter(item => item.projectId !== project.id);
            projectLinks = projectLinks.filter(item => item.sourceProjectId !== project.id && item.targetProjectId !== project.id);
            notes = notes.map(item => item.projectId === project.id ? { ...item, projectId: null } : item);
            images = images.map(item => item.projectId === project.id ? { ...item, projectId: null } : item);
            busy = false;
            notice = `Empezó la eliminación de “${project.name}”. Sus datos se están procesando por lotes.`;
            setTimeout(() => void refresh(true), 5000);
        } catch (e) { error = `No se pudo eliminar el proyecto: ${message(e)}`; }
        finally { busy = false; }
    }
    async function createProjectRelation() {
        if (!client || !relationSource || !relationTarget) return;
        try { await client.mutation(api.web.crearRelacionProyectos, { sourceProjectId: relationSource, targetProjectId: relationTarget, relationType: 'related_to', description: relationDescription }); relationDescription = ''; await refresh(true); notice = 'Relación entre proyectos guardada.'; }
        catch (e) { error = `No se pudo relacionar los proyectos: ${message(e)}`; }
    }
    async function deleteProjectRelation(link: any) {
        if (!client) return;
        try { await client.mutation(api.web.borrarRelacionProyecto, { linkId: link.id }); projectLinks = projectLinks.filter(item => item.id !== link.id); }
        catch (e) { error = `No se pudo quitar la relación: ${message(e)}`; }
    }
    async function createRemoteAgent() {
        if (!client) return;
        try {
            const created = await client.mutation(api.web.crearCredencialAgente, { name: remoteAgentName.trim(), model: remoteAgentModel.trim() || 'auto', modelProvider: remoteAgentProvider.trim() || 'auto', clientType: remoteAgentClient });
            remoteAgentKey = created.apiKey;
            remoteAgentCheck = ''; remoteAgentName = 'OpenCode'; remoteAgentModel = 'auto'; remoteAgentProvider = 'auto';
            await refresh(true); notice = 'Clave MCP creada. Cópiala ahora; no se volverá a mostrar.';
        } catch (e) { error = `No se pudo crear la conexión MCP: ${message(e)}`; }
    }
    async function revokeRemoteAgent(agent: any) {
        if (!client || !window.confirm(`¿Desactivar a ${agent.name}? Se conservarán sus tareas e historial.`)) return;
        try { await client.mutation(api.web.desactivarAgente, { agentId: agent.id }); agents = agents.map(item => item.id === agent.id ? { ...item, active: false } : item); notice = `Se desactivó el agente ${agent.name}.`; }
        catch (e) { error = `No se pudo desactivar el agente: ${message(e)}`; }
    }
    async function copyRemoteAgentKey() {
        try { await navigator.clipboard.writeText(remoteAgentKey); notice = 'Clave copiada al portapapeles.'; }
        catch { error = 'El navegador no permitió copiarla; selecciónala y cópiala manualmente.'; }
    }
    async function validateRemoteAgentKey() {
        if (!remoteAgentKey) return;
        remoteAgentChecking = true; remoteAgentCheck = '';
        try {
            const send = async (id: number, method: string, params?: unknown) => {
                const response = await fetch(MCP_ENDPOINT, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${remoteAgentKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
                    signal: AbortSignal.timeout(25_000),
                });
                const body = await response.text();
                let payload: any;
                try {
                    if (response.headers.get('content-type')?.includes('text/event-stream')) {
                        const data = body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).at(-1);
                        payload = data ? JSON.parse(data) : null;
                    } else payload = body ? JSON.parse(body) : null;
                } catch { throw new Error(`El servidor MCP respondió con contenido inesperado (${response.status}).`); }
                if (!response.ok) throw new Error(payload?.error ?? (response.status === 401 ? 'La clave no es válida o fue revocada.' : `El servidor respondió ${response.status}.`));
                if (payload?.error) throw new Error(payload.error.message ?? 'Falló la comunicación MCP.');
                return payload?.result;
            };
            await send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mitpad-setup-check', version: '1.0.0' } });
            const listed = await send(2, 'tools/list', {});
            const read = await send(3, 'tools/call', { name: 'mitpad_projects_list', arguments: {} });
            if (read?.isError) throw new Error(read.content?.[0]?.text ?? 'No se pudo consultar el workspace.');
            const textResult = read?.content?.find((part: any) => part.type === 'text')?.text ?? '[]';
            let projectCount = 0;
            try { const projects = JSON.parse(textResult); projectCount = Array.isArray(projects) ? projects.length : 0; } catch { /* A successful MCP tool call still confirms connectivity. */ }
            remoteAgentCheck = `Conexión MCP lista · ${listed?.tools?.length ?? 0} herramientas · ${projectCount} proyectos consultados`;
        } catch (e) {
            const detail = message(e);
            remoteAgentCheck = /failed to fetch|networkerror|network request failed/i.test(detail)
                ? 'No se alcanzó el servidor MCP. Revisa que esté activo e inténtalo de nuevo; la prueba también necesita conexión a internet.'
                : `La prueba MCP falló: ${detail}`;
        }
        finally { remoteAgentChecking = false; }
    }
    async function copyRemoteAgentSetup() {
        const setup = remoteAgentClient === 'codex'
            ? `# Añade esto a ~/.codex/config.toml\n# La clave se guarda en la configuración local de Codex. No subas este archivo a Git.\n\n[mcp_servers.mitpad]\nurl = "${MCP_ENDPOINT}"\nhttp_headers = { Authorization = "Bearer ${remoteAgentKey}" }\ntool_timeout_sec = 60\n`
            : `Conecta Mitpad como servidor MCP remoto usando Streamable HTTP.\nURL: ${MCP_ENDPOINT}\nTransporte: HTTP remoto (Streamable HTTP)\nAutorización: Bearer token individual de Mitpad.\nLa clave es privada: no la pegues en chats, repositorios ni logs.\nPrimero ejecuta una consulta de solo lectura a proyectos y comprueba que devuelve el workspace correcto. No hagas cambios hasta que te lo pida.\n\nEsta clave no se incluye en esta guía.`;
        try { await navigator.clipboard.writeText(setup); notice = remoteAgentClient === 'codex' ? 'Configuración de Codex copiada. Incluye la clave: guárdala solo en ~/.codex/config.toml.' : 'Guía de conexión copiada; no incluye la clave.'; }
        catch { error = 'No se pudieron copiar las instrucciones.'; }
    }
    async function createTask() {
        if (!client || !selectedProject || !newTaskTitle.trim()) return; busy = true;
        try { await client.mutation(api.web.crearTarea, { projectId: selectedProject, title: newTaskTitle.trim(), description: newTaskDescription.trim() }); newTaskTitle = ''; newTaskDescription = ''; await refresh(true); notice = 'Tarea agregada.'; }
        catch (e) { error = `No se pudo agregar la tarea: ${message(e)}`; } finally { busy = false; }
    }
    async function moveTask(task: any, next: Status) {
        if (!client || task.status === next) return;
        try { await client.mutation(api.web.actualizarTarea, { taskId: task.id, status: next }); tasks = tasks.map(t => t.id === task.id ? { ...t, status: next } : t); if (selectedTask?.id === task.id) selectedTask = { ...selectedTask, status: next }; }
        catch (e) { error = `No se pudo actualizar la tarea: ${message(e)}`; }
    }
    function dropTask(next: Status, event: DragEvent) {
        event.preventDefault();
        const id = event.dataTransfer?.getData('text/plain');
        const task = tasks.find(item => item.id === id);
        if (task) void moveTask(task, next);
    }
    async function openTask(task: any) {
        if (!client) return;
        selectedTask = { ...task }; taskComments = []; taskComment = '';
        try { taskComments = await client.query(api.web.comentariosTarea, { taskId: task.id }); }
        catch (e) { error = `No se pudo cargar la conversación: ${message(e)}`; }
    }
    async function saveTaskDetails() {
        if (!client || !selectedTask) return; busy = true;
        try {
            await client.mutation(api.web.actualizarTarea, { taskId: selectedTask.id, status: selectedTask.status, title: selectedTask.title, description: selectedTask.description, priority: selectedTask.priority, assigneeAgentId: selectedTask.assigneeAgentId ?? null });
            tasks = tasks.map(task => task.id === selectedTask.id ? { ...task, ...selectedTask } : task); notice = 'Tarea actualizada.';
        } catch (e) { error = `No se pudo guardar la tarea: ${message(e)}`; } finally { busy = false; }
    }
    async function addTaskComment() {
        if (!client || !selectedTask || !taskComment.trim()) return; busy = true;
        try { await client.mutation(api.web.crearComentarioTarea, { taskId: selectedTask.id, kind: taskCommentKind as any, content: taskComment.trim() }); taskComments = await client.query(api.web.comentariosTarea, { taskId: selectedTask.id }); taskComment = ''; await refresh(true); }
        catch (e) { error = `No se pudo añadir el comentario: ${message(e)}`; } finally { busy = false; }
    }
    function beginAgentEdit(agent: any) { editingAgent = agent; editAgentName = agent.name; editAgentModel = agent.model; editAgentProvider = agent.modelProvider; editAgentClient = agent.clientType; }
    async function saveAgentEdit() {
        if (!client || !editingAgent) return; busy = true;
        try { await client.mutation(api.web.editarAgente, { agentId: editingAgent.id, name: editAgentName, model: editAgentModel || 'auto', modelProvider: editAgentProvider || 'auto', clientType: editAgentClient }); editingAgent = null; await refresh(true); notice = 'Agente actualizado.'; }
        catch (e) { error = `No se pudo editar el agente: ${message(e)}`; } finally { busy = false; }
    }
    function chooseNote(note?: any) { selectedNote = note?.id ?? ''; noteTitle = note?.title ?? ''; noteContent = note?.content ?? ''; noteProject = note?.projectId ?? ''; noteStatus = note?.status ?? 'open'; }
    async function deleteNote(note: any) {
        if (!client || !window.confirm(`¿Eliminar permanentemente “${note.title || 'Sin título'}”? También se borrarán sus imágenes adjuntas.`)) return;
        busy = true;
        try {
            await client.mutation(api.web.borrarNota, { id: note.id });
            notes = notes.filter(item => item.id !== note.id);
            if (selectedNote === note.id) chooseNote();
            notice = 'Nota eliminada. El cambio se sincronizó con tu workspace.';
        } catch (e) { error = `No se pudo eliminar la nota: ${message(e)}`; }
        finally { busy = false; }
    }
    async function saveNote() {
        if (!client) return; busy = true;
        try { const id = await client.mutation(api.web.guardarNota, { id: selectedNote || undefined, title: noteTitle, content: noteContent, projectId: noteProject || null, status: noteStatus }); selectedNote = id; await refresh(true); notice = 'Nota guardada en Convex.'; }
        catch (e) { error = `No se pudo guardar la nota: ${message(e)}`; } finally { busy = false; }
    }
    async function uploadImage(file?: File, noteId?: string) {
        if (!client || (!selectedProject && !noteId) || !file) return;
        const noteProjectId = noteId ? notes.find(note => note.id === noteId)?.projectId ?? null : null;
        const projectId = noteId ? noteProjectId : selectedProject || null;
        const acceptedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!acceptedTypes.includes(file.type)) { error = 'Usa una imagen JPEG, PNG, WebP o GIF.'; return; }
        if (file.size > 10 * 1024 * 1024) { error = 'La imagen supera el límite de 10 MB.'; return; }
        uploading = true; error = '';
        try {
            const url = await client.mutation(api.web.crearUrlSubidaImagen, { projectId: projectId ?? undefined, noteId });
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
            if (!response.ok) throw new Error(`Carga fallida (${response.status}).`);
            const { storageId } = await response.json();
            await client.mutation(api.web.registrarImagen, { projectId: projectId ?? undefined, noteId, storageId, filename: file.name });
            await refresh(true); notice = noteId ? 'Imagen adjunta a la nota.' : 'Imagen vinculada al proyecto.';
        } catch (e) { error = `No se pudo cargar la imagen: ${message(e)}`; } finally { uploading = false; if (graphFile) graphFile.value = ''; }
    }
    async function deleteImage(image: any) { if (!client) return; try { await client.mutation(api.web.borrarImagen, { imageId: image.id }); images = images.filter(i => i.id !== image.id); } catch (e) { error = `No se pudo borrar la imagen: ${message(e)}`; } }
    async function signOut() { await authSignOut?.(); }
    async function openProfile() { showProfile = true; }
    function closeProfile() { showProfile = false; }
    function message(value: unknown) {
        const detail = value instanceof Error ? value.message : String(value);
        if (/^\s*(?:Error:\s*)?Not found\s*$/i.test(detail) || /\bHTTP 404\b/i.test(detail)) {
            return 'El servidor respondió “Not found”. La sesión puede seguir abierta; la web y Convex podrían estar en versiones distintas. Reintenta y, si persiste, cierra sesión y vuelve a entrar.';
        }
        return detail;
    }
    function date(value: number) { return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(value); }
</script>

<main class="web-shell">
    {#if lastAuthToken}
    <div class="app-shell">
        <aside class="sidebar">
            <a class="brand" href="/app"><img class="brand-mark" src="/mitpad-mark-web.webp" alt="" /><span>mitpad <small>AGENT WORKBENCH</small></span></a>
            <div class="sidebar-scroll">
                <div class="nav-label">WORKSPACE</div>
                <nav class="workspace-nav" aria-label="Secciones del workspace">
                    <button aria-label="Proyectos" title="Proyectos" class:active={section === 'projects'} on:click={() => section = 'projects'}><span>◫</span><span class="nav-text">Proyectos</span><span class="nav-count">{projects.length}</span></button>
                    <button aria-label="Tablero" title="Tablero" class:active={section === 'board'} on:click={() => section = 'board'}><span>▦</span><span class="nav-text">Tablero</span></button>
                    <button aria-label="Memoria" title="Memoria" class:active={section === 'notes'} on:click={() => section = 'notes'}><span>▤</span><span class="nav-text">Memoria</span><span class="nav-count">{notes.length}</span></button>
                    <button aria-label="Imágenes" title="Imágenes" class:active={section === 'images'} on:click={() => section = 'images'}><span>▧</span><span class="nav-text">Imágenes</span><span class="nav-count">{images.length}</span></button>
                    <button aria-label="Actividad" title="Actividad" class:active={section === 'activity'} on:click={() => section = 'activity'}><span>◷</span><span class="nav-text">Actividad</span></button>
                    <button aria-label="Agentes" title="Agentes" class:active={section === 'agents'} on:click={() => section = 'agents'}><span>⌘</span><span class="nav-text">Agentes</span><span class="nav-count">{agents.length}</span></button>
                    <button aria-label="Variables privadas" title="Variables privadas" class:active={section === 'secrets'} on:click={() => section = 'secrets'}><span>⚿</span><span class="nav-text">Claves privadas</span></button>
                    <button aria-label="Mapa" title="Mapa" class:active={section === 'graph'} on:click={() => section = 'graph'}><span>◎</span><span class="nav-text">Mapa</span></button>
                </nav>
                <section class="sidebar-projects"><div class="nav-label">PROYECTOS</div>{#each projects.slice(0, 12) as project (project.id)}<button class="project-link" class:project-active={selectedProject === project.id} title={project.name} on:click={() => { selectedProject = project.id; section = 'board'; }}><i class="project-dot"></i>{project.name}</button>{/each}{#if !projects.length}<small class="side-empty">Aún no hay proyectos</small>{/if}</section>
            </div>
            <div class="sidebar-bottom"><button class="sidebar-user" on:click={() => void openProfile()}><span class="pilot-avatar">{userEmail.slice(0, 1).toUpperCase()}</span><span class="pilot-text"><strong>{userEmail}</strong><small>Mi perfil</small></span></button><span class="cloud-indicator" class:cloud-on={connected} title={connected ? 'Sincronizado con Convex' : 'Sin conexión'}>●</span></div>
        </aside>
        <div class="main-area">
            <header class="topbar"><div class="breadcrumbs"><span>mitpad</span><span class="crumb-sep">/</span><strong>{section === 'board' ? 'Tablero' : section === 'notes' ? 'Memoria' : section === 'images' ? 'Imágenes' : section === 'activity' ? 'Actividad' : section === 'agents' ? 'Agentes' : section === 'secrets' ? 'Claves privadas' : section === 'graph' ? 'Mapa' : 'Proyectos'}</strong></div><div class="top-actions"><span class="sync-pill" class:sync-offline={!connected}>{connected ? '● Conectado · 5 min' : '○ Reconectando'}</span><button class="secondary" on:click={() => void refresh()} disabled={busy}>{busy ? 'Actualizando…' : 'Actualizar'}</button><button class="avatar-button" on:click={() => void openProfile()}>Perfil</button><button class="secondary" on:click={() => void signOut()}>Salir</button></div></header>
            {#if error}<div class="alert error">{error}</div>{/if}{#if notice}<div class="alert notice">{notice}</div>{/if}
            <section class="dashboard">
        {#if !connected}<div class="reconnect-banner"><strong>Workspace sin actualizar</strong><span>Conservamos esta vista y volveremos a intentarlo automáticamente.</span><button on:click={() => void refresh()} disabled={busy}>{busy ? 'Conectando…' : 'Reintentar ahora'}</button></div>{/if}<div class="intro"><div><div class="eyebrow">SUPERVISIÓN DEL WORKSPACE</div><h1>Proyectos y agentes, de un vistazo</h1><p>Monitorea cambios, notas y archivos desde Convex.</p></div><div class="last-sync"><span>Última consulta</span><strong>{lastSync ? date(lastSync) : 'Conectando…'}</strong><small>{projects.length} proyectos · {tasks.length} tareas · {agents.length} agentes</small></div></div>
        {#if section === 'board'}
            <div class="summary-grid"><article><span>Proyectos</span><strong>{projects.length}</strong><small>{projects.filter(p => p.status === 'active').length} activos</small></article><article><span>Tareas abiertas</span><strong>{tasks.filter(t => t.status !== 'done').length}</strong><small>{tasks.filter(t => t.status === 'blocked').length} bloqueadas</small></article><article><span>Agentes</span><strong>{agents.length}</strong><small>{agents.filter(a => a.active).length} activos</small></article><article><span>Actividad</span><strong>{events.length}</strong><small>eventos recientes</small></article></div>
            <div class="workspace-grid"><section class="work-panel"><div class="panel-head"><div><div class="eyebrow">SEGUIMIENTO</div><h2>{selectedProjectName}</h2></div><select aria-label="Filtrar por proyecto" bind:value={selectedProject}><option value="">Todos los proyectos</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select></div>
                <div class="filters"><select aria-label="Filtrar por estado" bind:value={taskStatusFilter}><option value="all">Todos los estados</option>{#each statuses as s}<option value={s.id}>{s.label}</option>{/each}</select><select aria-label="Filtrar por agente" bind:value={agentFilter}><option value="all">Todos los agentes</option><option value="unassigned">Sin asignar</option>{#each agents as a (a.id)}<option value={a.id}>{a.name}</option>{/each}</select><select aria-label="Filtrar por prioridad" bind:value={priorityFilter}><option value="all">Todas las prioridades</option>{#each ['urgent','high','medium','low'] as p}<option value={p}>{p}</option>{/each}</select><input bind:value={search} placeholder="Buscar tareas…" aria-label="Buscar tareas" /></div>
                {#if selectedProject}<form class="task-create" on:submit|preventDefault={createTask}><input bind:value={newTaskTitle} placeholder="Nueva tarea…" required /><input bind:value={newTaskDescription} placeholder="Descripción opcional" /><button disabled={busy}>＋ Agregar tarea</button></form>{/if}
                <div class="task-drop-targets" aria-label="Mover tarea arrastrándola a un estado">{#each [{id:'todo',label:'Pendiente'},{id:'in_progress',label:'En curso'},{id:'done',label:'Hecho'}] as lane}<button type="button" on:dragover={(event) => event.preventDefault()} on:drop={(event) => dropTask(lane.id as Status,event)}><span>{lane.label}</span></button>{/each}</div>
                {#if visibleTasks.length}<div class="task-list">{#each visibleTasks as t (t.id)}<article class="task" draggable="true" on:dragstart={(event) => event.dataTransfer?.setData('text/plain', t.id)}><div class="task-main"><span class="priority" class:urgent={t.priority === 'urgent'}></span><div><strong>{t.title}</strong><p>{t.description || 'Sin descripción'}</p><small>{projects.find(p => p.id === t.projectId)?.name ?? 'Proyecto'} · {t.assigneeAgentId ? agents.find(a => a.id === t.assigneeAgentId)?.name ?? 'Agente' : t.createdByType === 'agent' ? 'Creada por agente' : 'Sin asignar'}</small></div></div><div class="task-actions"><select aria-label={`Estado de ${t.title}`} value={t.status} on:change={e => void moveTask(t, (e.currentTarget as HTMLSelectElement).value as Status)}>{#each statuses as s}<option value={s.id}>{s.label}</option>{/each}</select><button class="task-open" on:click={() => void openTask(t)}>Detalles</button></div></article>{/each}</div>{:else}<div class="empty">No hay tareas con estos filtros.</div>{/if}
                <form class="create-project" on:submit|preventDefault={createProject}><strong>＋ Nuevo proyecto</strong><input bind:value={newProjectName} placeholder="Nombre" required /><input bind:value={newProjectDescription} placeholder="Objetivo o contexto" /><button disabled={busy}>Crear</button></form>
            </section><aside class="side-column"><section class="side-panel"><div class="eyebrow">AGENTES</div><h2>Equipo de trabajo</h2>{#each agents as a (a.id)}<div class="agent"><span class:online={a.active}></span><div><strong>{a.name}</strong><small>{a.model || a.clientType} · {a.active ? 'Activo' : 'Inactivo'}</small></div>{#if a.lastSeenAt}<time>{date(a.lastSeenAt)}</time>{/if}</div>{/each}{#if !agents.length}<p class="empty-small">Aún no hay agentes registrados.</p>{/if}</section><section class="side-panel"><div class="eyebrow">ACTIVIDAD</div><h2>Últimos movimientos</h2><select class="activity-filter" aria-label="Filtrar actividad" bind:value={activityFilter}><option value="all">Todos</option><option value="agent">Agentes</option><option value="human">Personas</option></select><div class="events">{#each events.filter(e => activityFilter === 'all' || e.actorType === activityFilter).slice(0, 12) as e (e.id)}<article><i class:agent-event={e.actorType === 'agent'}></i><div><strong>{e.summary}</strong><small>{e.actorType === 'agent' ? `Agente ${e.actorId}` : 'Piloto'} · {date(e.createdAt)}</small></div></article>{/each}</div></section></aside></div>
        {:else if section === 'projects'}<section class="work-panel project-library"><div class="panel-head"><div><div class="eyebrow">ESPACIOS DE TRABAJO</div><h2>Proyectos</h2></div><span>{projects.length} en tu workspace</span></div><form class="create-project" on:submit|preventDefault={createProject}><input bind:value={newProjectName} placeholder="Nombre del proyecto" required /><input bind:value={newProjectDescription} placeholder="Objetivo o contexto" /><button disabled={busy}>＋ Crear proyecto</button></form><div class="project-grid">{#each projects as p (p.id)}<article class="project-card" class:selected={selectedProject === p.id}><button class="project-open" on:click={() => { selectedProject = p.id; section = 'board'; }}><span class="project-status" class:archived={p.status === 'archived'}>{p.status === 'active' ? 'Activo' : 'Archivado'}</span><strong>{p.name}</strong><p>{p.description || 'Sin descripción'}</p><small>{tasks.filter(t => t.projectId === p.id).length} tareas · {knowledge.filter(k => k.projectId === p.id).length} elementos de contexto</small></button><div class="project-card-actions"><button class="project-edit-button" on:click={() => startProjectEdit(p)}>Editar</button><button class="project-delete-button" on:click={() => void deleteProject(p)} disabled={busy}>Eliminar</button></div></article>{/each}{#if !projects.length}<div class="empty">Crea tu primer proyecto para empezar.</div>{/if}</div>{#if editingProject}<form class="project-edit-form" on:submit|preventDefault={saveProjectEdit}><div class="eyebrow">EDITAR PROYECTO</div><input bind:value={editProjectName} placeholder="Nombre" required /><textarea bind:value={editProjectDescription} placeholder="Descripción" rows="3"></textarea><div><button class="primary" disabled={busy}>Guardar cambios</button><button type="button" class="subtle-button" on:click={() => editingProject = ''}>Cancelar</button></div></form>{/if}<section class="project-relations"><div class="eyebrow">CONEXIONES</div><h3>Relaciones entre proyectos</h3><form class="relation-form" on:submit|preventDefault={createProjectRelation}><select aria-label="Proyecto de origen" bind:value={relationSource}><option value="">Desde…</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select><select aria-label="Proyecto relacionado" bind:value={relationTarget}><option value="">Hacia…</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select><input bind:value={relationDescription} placeholder="Qué los relaciona" /><button disabled={!relationSource || !relationTarget || relationSource === relationTarget}>Vincular</button></form>{#each projectLinks as link (link.id)}<div class="relation-row"><span>{projects.find(p => p.id === link.sourceProjectId)?.name ?? 'Proyecto'} ↔ {projects.find(p => p.id === link.targetProjectId)?.name ?? 'Proyecto'}</span><small>{link.description || link.relationType}</small><button on:click={() => void deleteProjectRelation(link)} aria-label="Quitar relación">×</button></div>{/each}</section></section>
        {:else if section === 'notes'}<div class="content-grid"><section class="side-panel note-list"><div class="eyebrow">MEMORIA</div><h2>Notas conservadas</h2>{#each notes as n (n.id)}<div class="note-row-wrap"><button class="note-row" class:selected={selectedNote === n.id} on:click={() => chooseNote(n)}><strong>{n.title || 'Sin título'}</strong><small>{n.status === 'attended' ? 'Atendida' : 'Abierta'} · {projects.find(p => p.id === n.projectId)?.name ?? 'Sin proyecto'}</small></button><button class="note-delete" aria-label={`Eliminar nota ${n.title || 'sin título'}`} title="Eliminar nota" on:click={() => void deleteNote(n)} disabled={busy}>×</button></div>{/each}<button class="new-note" on:click={() => chooseNote()}>＋ Nueva nota</button></section><section class="work-panel note-editor"><div class="eyebrow">{selectedNote ? 'EDITAR NOTA' : 'NUEVA NOTA'}</div><input class="note-title" bind:value={noteTitle} placeholder="Título" /><div class="note-meta"><select aria-label="Proyecto asociado" bind:value={noteProject}><option value="">Sin proyecto</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select><select aria-label="Estado de nota" bind:value={noteStatus}><option value="open">Abierta</option><option value="attended">Atendida</option></select></div><textarea bind:value={noteContent} placeholder="Escribe contexto útil para ti y tus agentes…"></textarea><button class="primary" on:click={() => void saveNote()} disabled={busy}>Guardar nota</button>{#if selectedNote}<label class="upload note-upload">＋ Adjuntar imagen<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={uploading} on:change={e => void uploadImage((e.currentTarget as HTMLInputElement).files?.[0], selectedNote)} /></label><div class="note-attachments">{#each images.filter(image => image.noteId === selectedNote) as image (image.id)}<figure><a href={image.url ?? '#'} target="_blank" rel="noreferrer"><img src={image.url ?? ''} alt={image.filename} loading="lazy" /></a><figcaption>{image.filename}<button on:click={() => void deleteImage(image)} aria-label={`Eliminar ${image.filename}`}>×</button></figcaption></figure>{/each}</div>{/if}</section></div>
        {:else if section === 'images'}<section class="work-panel image-library"><div class="panel-head"><div><div class="eyebrow">ARCHIVOS DEL PROYECTO</div><h2>Imágenes</h2></div><select aria-label="Proyecto para imágenes" bind:value={selectedProject}><option value="">Elige un proyecto</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select></div><p>Las imágenes se guardan en Convex Storage y quedan vinculadas al proyecto seleccionado. Límite: 10 MB por archivo.</p><label class="upload">{uploading ? 'Subiendo…' : '＋ Subir imagen'}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={!selectedProject || uploading} on:change={e => void uploadImage((e.currentTarget as HTMLInputElement).files?.[0])} /></label><div class="image-grid">{#each images.filter(i => !selectedProject || i.projectId === selectedProject) as image (image.id)}<article><a href={image.url ?? '#'} target="_blank" rel="noreferrer"><img src={image.url ?? ''} alt={image.filename} loading="lazy" /></a><div><strong>{image.filename}</strong><small>{projects.find(p => p.id === image.projectId)?.name ?? 'Proyecto'} · {(image.size / 1024).toFixed(0)} KB</small><button on:click={() => void deleteImage(image)}>Quitar</button></div></article>{/each}</div>{#if !images.length}<div class="empty">Todavía no hay imágenes.</div>{/if}</section>
        {:else if section === 'activity'}<section class="work-panel"><div class="panel-head"><div><div class="eyebrow">HISTORIAL</div><h2>Actividad reciente</h2></div><select class="activity-filter" aria-label="Filtrar actividad" bind:value={activityFilter}><option value="all">Todas</option><option value="agent">Agentes</option><option value="human">Personas</option></select></div><div class="events">{#each events.filter(e => activityFilter === 'all' || e.actorType === activityFilter) as e (e.id)}<article><i class:agent-event={e.actorType === 'agent'}></i><div><strong>{e.summary}</strong><small>{e.actorType === 'agent' ? `Agente ${e.actorId}` : 'Persona'} · {date(e.createdAt)}</small></div></article>{/each}{#if !events.length}<div class="empty">Aún no hay actividad registrada.</div>{/if}</div></section>
        {:else if section === 'secrets'}{#if client}<PrivateVault {client} />{/if}
        {:else if section === 'agents'}<section class="work-panel"><div class="eyebrow">EQUIPO Y CONEXIONES</div><h2>Conecta tu agente en un momento</h2><p class="graph-hint">Elige Codex, crea una credencial y copia una configuración lista para pegar. Después probamos la conexión real con el servidor MCP y una lectura de tus proyectos.</p><div class="agent-connect-guide"><span class="guide-step">01</span><div><strong>Elige tu cliente</strong><p>La guía se adapta a Codex, OpenCode y otros clientes MCP.</p></div><span class="guide-step">02</span><div><strong>Crea una clave exclusiva</strong><p>Puedes revocarla cuando quieras; Mitpad conserva solo su hash.</p></div><span class="guide-step">03</span><div><strong>Prueba antes de usar</strong><p>Confirmamos el saludo MCP, la lista de herramientas y una lectura real.</p></div></div><form class="remote-agent-form" on:submit|preventDefault={createRemoteAgent}><label>Cliente<select bind:value={remoteAgentClient}><option value="codex">Codex</option><option value="opencode">OpenCode</option><option value="claude-code">Claude Code</option><option value="cursor">Cursor</option><option value="mcp">Otro cliente MCP</option></select></label><label>Nombre del agente<input bind:value={remoteAgentName} maxlength="100" required placeholder="Codex personal" /></label><label>Modelo<input bind:value={remoteAgentModel} maxlength="120" placeholder="auto" /></label><label>Proveedor<input bind:value={remoteAgentProvider} maxlength="80" placeholder="auto" /></label><button disabled={busy}>Crear y configurar</button></form>{#if remoteAgentKey}<div class="remote-agent-secret"><div><strong>Ahora configura Codex y comprueba la conexión</strong><p>La opción de Codex copia una tabla TOML lista para añadir a tu configuración local. Incluye la clave secreta: no pegues ese contenido en un repositorio ni lo compartas.</p></div><code>{remoteAgentKey}</code>{#if remoteAgentCheck}<p class="agent-key-check">{remoteAgentCheck}</p>{/if}<div class="agent-secret-actions"><button on:click={() => void copyRemoteAgentKey()}>Copiar solo la clave</button><button class="subtle-button" on:click={() => void copyRemoteAgentSetup()}>{remoteAgentClient === 'codex' ? 'Copiar configuración de Codex' : 'Copiar guía MCP'}</button><button class="subtle-button" on:click={() => void validateRemoteAgentKey()} disabled={remoteAgentChecking}>{remoteAgentChecking ? 'Probando servidor MCP…' : 'Probar conexión completa'}</button><button class="subtle-button" on:click={() => { remoteAgentKey = ''; remoteAgentCheck = ''; }}>Ocultar clave</button></div></div>{/if}<div class="eyebrow agent-list-label">AGENTES REGISTRADOS</div>{#if editingAgent}<form class="agent-edit-form" on:submit|preventDefault={saveAgentEdit}><strong>Editar {editingAgent.name}</strong><label>Nombre<input bind:value={editAgentName} required maxlength="100" /></label><label>Modelo<input bind:value={editAgentModel} maxlength="120" /></label><label>Proveedor<input bind:value={editAgentProvider} maxlength="80" /></label><label>Cliente<input bind:value={editAgentClient} maxlength="80" /></label><div><button class="primary" disabled={busy}>Guardar</button><button type="button" class="secondary" on:click={() => editingAgent = null}>Cancelar</button></div></form>{/if}{#each agents as a (a.id)}<div class="agent"><span class:online={a.active}></span><div><strong>{a.name}{a.credentialMode === 'mcp' ? ' · MCP' : ''}</strong><small>{a.model || a.clientType} · {a.active ? 'Activo' : 'Revocado'}</small></div>{#if a.lastSeenAt}<time>{date(a.lastSeenAt)}</time>{/if}<button class="agent-edit-button" on:click={() => beginAgentEdit(a)}>Editar</button>{#if a.active && a.name.toLowerCase() !== 'meido'}<button class="revoke-agent" on:click={() => void revokeRemoteAgent(a)}>Desactivar</button>{/if}</div>{/each}{#if !agents.length}<div class="empty">Aún no hay agentes. Crea una clave MCP para conectar el primero.</div>{/if}</section>
        {:else}<section class="work-panel graph-workspace"><div class="panel-head"><div><div class="eyebrow">MAPA DEL WORKSPACE</div><h2>Grafo 3D</h2></div><select aria-label="Proyecto visible en el mapa" bind:value={selectedProject}><option value="">Todos los proyectos</option>{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select></div><p class="graph-hint">{selectedProject ? 'Vista del proyecto: tareas y conocimiento quedan agrupados alrededor de su proyecto.' : 'Vista general: muestra proyectos y sus relaciones. Elige un proyecto para explorar sus tareas y conocimiento.'} Arrastra para orbitar y usa la rueda para acercar.</p><div class="graph-canvas"><ThreeDGraph nodes={graphNodes} links={graphLinks} onSelect={(node) => selectedGraphNode = node} /></div>{#if selectedGraphNode}<aside class="graph-detail"><strong>{selectedGraphNode.label}</strong><span>{selectedGraphNode.kind === 'project' ? 'Proyecto' : selectedGraphNode.kind === 'task' ? 'Tarea' : selectedGraphNode.knowledgeKind}</span>{#if selectedGraphNode.summary}<p>{selectedGraphNode.summary}</p>{/if}{#if selectedGraphNode.source}<small>{selectedGraphNode.source}</small>{/if}</aside>{/if}</section>{/if}
    </section>
        </div>
    </div>
    {#if selectedTask}<div class="task-modal-backdrop" role="presentation" on:click={(event) => { if (event.target === event.currentTarget) selectedTask = null; }}><dialog open class="task-dialog" aria-label="Detalle de tarea"><header><div><div class="eyebrow">TAREA · {projects.find(project => project.id === selectedTask.projectId)?.name ?? 'Proyecto'}</div><h2>Detalles y conversación</h2></div><button class="secondary" on:click={() => selectedTask = null}>Cerrar</button></header><label>Título<input bind:value={selectedTask.title} maxlength="200" /></label><label>Descripción<textarea bind:value={selectedTask.description} rows="4"></textarea></label><div class="task-detail-fields"><label>Estado<select bind:value={selectedTask.status}>{#each statuses as s}<option value={s.id}>{s.label}</option>{/each}</select></label><label>Prioridad<select bind:value={selectedTask.priority}><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label><label>Agente<select bind:value={selectedTask.assigneeAgentId}><option value={null}>Sin asignar</option>{#each agents.filter(agent => agent.active) as agent (agent.id)}<option value={agent.id}>{agent.name}</option>{/each}</select></label></div><button class="primary" on:click={() => void saveTaskDetails()} disabled={busy}>Guardar tarea</button><section class="task-conversation"><div class="eyebrow">CONVERSACIÓN · {taskComments.length}</div><form on:submit|preventDefault={addTaskComment}><select bind:value={taskCommentKind} aria-label="Tipo de comentario"><option value="message">Comentario</option><option value="instruction">Instrucción</option><option value="question">Pregunta</option><option value="decision">Decisión</option><option value="update">Actualización</option></select><textarea bind:value={taskComment} placeholder="Añade contexto para tu equipo o agente…" rows="3"></textarea><button class="primary" disabled={busy || !taskComment.trim()}>Añadir comentario</button></form><div class="task-comment-list">{#each taskComments as comment (comment.id)}<article><div><strong>{comment.authorType === 'agent' ? 'Agente' : 'Tú'}</strong><span>{comment.kind}</span><time>{date(comment.createdAt)}</time></div><p>{comment.content}</p></article>{/each}{#if !taskComments.length}<p class="empty-small">Aún no hay conversación en esta tarea.</p>{/if}</div></section></dialog></div>{/if}
    {/if}
    <div class="auth-shell" class:auth-hidden={!!lastAuthToken}>
        <header class="auth-header"><a class="brand" href="/"><img class="brand-icon" src="/mitpad-mark-web.webp" alt="" /><span>mitpad <small>AGENT WORKBENCH · WEB</small></span></a><a class="back-to-landing" href="/">← Volver a la página principal</a></header>
        {#if error}<div class="alert error">{error}</div>{/if}{#if notice}<div class="alert notice">{notice}</div>{/if}
        <div class="auth-content"><section class="connect-card"><img class="login-mark" src="/mitpad-mark-web.webp" alt="Mitpad" /><div class="eyebrow">CUENTA MITPAD</div><h1>Entra a tu workspace</h1><p>Inicia sesión o crea una cuenta con correo y contraseña. Cada cuenta tiene su espacio privado.</p><div class="auth-island-host" bind:this={authNode}></div></section></div>
    </div>
    {#if showProfile && client}<div class="profile-backdrop" role="presentation"><dialog open class="profile-dialog" aria-label="Perfil de usuario"><header><div><div class="eyebrow">CUENTA MITPAD</div><h2>Mi perfil</h2></div><button class="sign-out" on:click={closeProfile}>Cerrar</button></header><AccountProfile {client} email={userEmail} onSignOut={signOut} /></dialog></div>{/if}
</main>

<style>
    :global(*) { box-sizing: border-box; }
    :global(html) { color-scheme: dark; }
    :global(body) { margin: 0; background: #191c17; color: #f2eee3; font: 15px/1.55 'Instrument Sans', system-ui, sans-serif; }
    :global(button), :global(input), :global(select), :global(textarea) { font: inherit; }
    :global(button:focus-visible), :global(a:focus-visible), :global(input:focus-visible), :global(select:focus-visible), :global(textarea:focus-visible) { outline: 2px solid #b3bd8f; outline-offset: 2px; }
    .web-shell { --bg:#191c17; --surface:#20231c; --panel:#24271f; --panel-raised:#2b2e24; --line:#3b4034; --text:#f2eee3; --muted:#b8b5a7; --quiet:#969688; --sage:#b3bd8f; --clay:#dfa284; min-height:100vh; background:var(--bg); color:var(--text); }
    .app-shell { display:grid; grid-template-columns:252px minmax(0,1fr); min-height:100vh; }
    .sidebar { position:sticky; top:0; display:flex; flex-direction:column; height:100vh; min-height:0; padding:26px 18px 16px; background:#1d201a; border-right:1px solid var(--line); }
    .brand { display:flex; align-items:center; gap:12px; min-width:0; padding:0 8px 30px; color:var(--text); text-decoration:none; font:600 22px/1 'Bricolage Grotesque',Georgia,serif; letter-spacing:-.04em; }
    .brand-mark,.brand-icon { width:36px; height:36px; flex:none; object-fit:cover; border:1px solid #4a4b3d; border-radius:10px; }
    .brand small { display:block; margin-top:6px; color:var(--quiet); font:600 9px/1 'Instrument Sans',system-ui,sans-serif; letter-spacing:.16em; }
    .sidebar-scroll { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:#4b4d3f transparent; }
    .nav-label,.eyebrow { color:var(--quiet); font-size:10px; font-weight:700; letter-spacing:.15em; text-transform:uppercase; }
    .nav-label { padding:12px 10px 8px; }
    .workspace-nav { display:grid; gap:3px; }
    .workspace-nav button,.project-link { display:flex; align-items:center; gap:12px; width:100%; min-height:42px; padding:9px 11px; border:0; border-radius:7px; background:transparent; color:#c5c2b7; text-align:left; cursor:pointer; transition:background .16s,color .16s; }
    .workspace-nav button:hover,.project-link:hover { background:#2a2d24; color:var(--text); }
    .workspace-nav button.active { background:#34372c; color:#e7e8d7; }
    .workspace-nav button>span:first-child { width:18px; color:var(--sage); text-align:center; font-size:16px; }
    .nav-text { flex:1; }
    .nav-count { color:var(--quiet); font-size:12px; font-variant-numeric:tabular-nums; }
    .sidebar-projects { margin-top:26px; }
    .project-link { min-height:36px; overflow:hidden; color:var(--muted); font-size:13px; white-space:nowrap; text-overflow:ellipsis; }
    .project-dot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--clay); }
    .project-active { background:#34372c!important; color:var(--text)!important; }
    .side-empty { display:block; padding:5px 10px; color:var(--quiet); font-size:12px; }
    .sidebar-bottom { display:flex; align-items:center; gap:10px; flex:none; margin-top:16px; padding:14px 4px 0; border-top:1px solid var(--line); }
    .sidebar-user { display:flex; align-items:center; gap:10px; min-width:0; padding:0; border:0; background:none; color:inherit; text-align:left; cursor:pointer; }
    .pilot-avatar { display:grid; width:34px; height:34px; flex:none; place-items:center; border:1px solid #5b5a46; border-radius:50%; background:#34372c; color:#e4c0a4; font-weight:600; }
    .pilot-text { display:grid; min-width:0; gap:3px; font-size:12px; }
    .pilot-text strong,.pilot-text small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pilot-text small { color:var(--quiet); font-size:11px; }
    .cloud-indicator { margin-left:auto; color:#888b78; font-size:11px; }
    .cloud-indicator.cloud-on { color:#b3bd8f; }
    .main-area { display:flex; min-width:0; min-height:100vh; flex-direction:column; }
    .topbar { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between; gap:18px; min-height:68px; padding:0 clamp(22px,4vw,56px); border-bottom:1px solid #ffffff0c; background:#191c17e8; backdrop-filter:blur(16px); }
    .breadcrumbs { display:flex; align-items:center; gap:11px; min-width:0; color:var(--quiet); font-size:13px; }
    .breadcrumbs strong { overflow:hidden; color:var(--text); font-weight:600; text-overflow:ellipsis; white-space:nowrap; }
    .crumb-sep { color:#66695a; }
    .top-actions { display:flex; align-items:center; gap:9px; }
    .sync-pill { color:var(--muted); font-size:12px; white-space:nowrap; }
    .sync-pill.sync-offline { color:#e4a68a; }
    .secondary,.avatar-button,.subtle-button,.project-edit-button,.project-delete-button,.revoke-agent { min-height:36px; padding:7px 12px; border:1px solid #555646; border-radius:6px; background:transparent; color:#e1ddcf; font-size:12px; cursor:pointer; transition:border-color .16s,background .16s; }
    .secondary:hover,.avatar-button:hover,.subtle-button:hover,.project-edit-button:hover { border-color:var(--sage); background:#2a2d24; }
    .secondary:disabled,.primary:disabled { opacity:.55; cursor:wait; }
    .avatar-button { border-color:transparent; color:#e4b294; }
    .dashboard { width:min(1480px,100%); margin:0 auto; padding:34px clamp(22px,4vw,56px) 72px; }
    .intro { display:flex; align-items:flex-end; justify-content:space-between; gap:28px; margin-bottom:28px; padding-bottom:24px; border-bottom:1px solid var(--line); }
    .intro h1,.connect-card h1 { margin:9px 0 8px; color:var(--text); font:600 clamp(30px,3.2vw,44px)/1.04 'Bricolage Grotesque',Georgia,serif; letter-spacing:-.045em; }
    .intro p,.connect-card>p { max-width:58ch; margin:0; color:#c0beb2; font-size:15px; }
    .last-sync { display:grid; gap:4px; flex:none; color:var(--quiet); font-size:11px; text-align:right; }
    .last-sync strong { color:var(--text); font-size:13px; font-weight:500; }
    .last-sync small { color:var(--muted); font-size:11px; }
    .summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:0 0 18px; }
    .summary-grid article,.work-panel,.side-panel { min-width:0; border:1px solid var(--line); border-radius:14px; background:linear-gradient(145deg,#272a22,var(--panel) 64%); box-shadow:0 14px 38px #00000012; }
    .summary-grid article { padding:17px 18px; }
    .summary-grid span,.summary-grid small { display:block; color:var(--muted); font-size:12px; }
    .summary-grid strong { display:block; margin:7px 0 2px; color:var(--text); font:500 31px/1 'Bricolage Grotesque',Georgia,serif; font-variant-numeric:tabular-nums; }
    .summary-grid small { color:var(--quiet); }
    .workspace-grid { display:grid; grid-template-columns:minmax(0,1.65fr) minmax(280px,.8fr); gap:16px; align-items:start; }
    .work-panel { padding:22px; }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:14px; }
    .panel-head h2,.side-panel h2,.work-panel>h2 { margin:6px 0 0; color:var(--text); font:600 21px/1.15 'Bricolage Grotesque',Georgia,serif; letter-spacing:-.025em; }
    .panel-head>span { color:var(--muted); font-size:12px; }
    .panel-head select,.task select,.filters select,.filters input,.task-create input,.create-project input,.note-meta select,.image-library select,.project-edit-form input,.project-edit-form textarea,.relation-form input,.relation-form select,.remote-agent-form input,.remote-agent-form select { min-width:0; padding:9px 11px; border:1px solid #555646; border-radius:6px; background:#1b1e19; color:var(--text); }
    .filters { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0 12px; }
    .filters select,.filters input { font-size:12px; }
    .filters input { flex:1; min-width:140px; }
    .filters input::placeholder,.task-create input::placeholder,.create-project input::placeholder { color:#929384; }
    .task-create { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; padding:14px 0; border-block:1px solid var(--line); }
    .task-create input { flex:1 1 180px; }
    .primary,.task-create button,.create-project button,.new-note,.upload,.remote-agent-form button,.relation-form button { min-height:40px; padding:9px 15px; border:0; border-radius:6px; background:var(--clay); color:#251b16; font-weight:650; cursor:pointer; }
    .primary:hover,.task-create button:hover,.create-project button:hover,.new-note:hover,.remote-agent-form button:hover,.relation-form button:hover { background:#edb497; }
    .task-list { display:grid; }
    .task { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:15px 2px; border-bottom:1px solid #3a3e33; }
    .task-main { display:flex; align-items:flex-start; gap:12px; min-width:0; }
    .task-main>div { min-width:0; }
    .task strong { color:var(--text); font-size:14px; font-weight:600; }
    .task p { margin:4px 0; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    .task small { color:var(--quiet); font-size:11px; }
    .priority { width:8px; height:8px; flex:none; margin-top:6px; border-radius:50%; background:#b3bd8f; }
    .priority.urgent { background:#d98975; }
    .task select { flex:none; font-size:12px; }
    .create-project { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:20px; padding-top:17px; border-top:1px solid var(--line); }
    .create-project strong { flex:none; color:var(--muted); font-size:12px; }
    .create-project input { flex:1 1 150px; }
    .create-project button { min-height:38px; }
    .side-column { display:grid; gap:14px; }
    .side-panel { padding:19px; }
    .side-panel h2 { margin-bottom:12px; }
    .agent { display:flex; align-items:center; gap:10px; padding:12px 0; border-bottom:1px solid #3a3e33; }
    .agent:last-of-type { border:0; }
    .agent>span { width:8px; height:8px; flex:none; border-radius:50%; background:#77796a; }
    .agent>span.online { background:var(--sage); }
    .agent>div { display:grid; flex:1; gap:3px; min-width:0; }
    .agent strong { color:var(--text); font-size:13px; }
    .agent small,.agent time { color:var(--muted); font-size:11px; }
    .agent time { white-space:nowrap; }
    .events { display:grid; margin-top:10px; }
    .events article { display:flex; gap:11px; padding:12px 0; border-bottom:1px solid #3a3e33; }
    .events article:last-child { border:0; }
    .events i { width:7px; height:7px; flex:none; margin-top:6px; border-radius:50%; background:var(--sage); }
    .events i.agent-event { background:var(--clay); }
    .events article div { display:grid; gap:4px; }
    .events strong { color:#e8e4d9; font-size:12px; font-weight:500; line-height:1.4; }
    .events small { color:var(--quiet); font-size:11px; }
    .activity-filter { margin-top:12px; padding:8px 10px; border:1px solid #555646; border-radius:6px; background:#1b1e19; color:var(--text); }
    .empty,.empty-small { color:var(--muted); font-size:13px; padding:28px 12px; text-align:center; }
    .empty { border:1px dashed #555646; border-radius:7px; }
    .empty-small { padding:14px 0; }
    .project-library { margin-top:0; }
    .project-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; margin-top:18px; }
    .project-card { display:flex; min-height:180px; flex-direction:column; justify-content:space-between; gap:14px; padding:18px; border:1px solid var(--line); border-radius:13px; background:linear-gradient(150deg,#24271f,#1e211b); transition:border-color .2s,background .2s,transform .2s,box-shadow .2s; }
    .project-card:hover,.project-card.selected { transform:translateY(-2px); border-color:#77795e; background:#292c23; box-shadow:0 13px 30px #00000020; }
    .project-open { display:grid; flex:1; align-content:start; gap:9px; padding:0; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; }
    .project-open strong { color:var(--text); font:600 19px/1.15 'Bricolage Grotesque',Georgia,serif; }
    .project-open p { margin:0; color:var(--muted); font-size:13px; line-height:1.5; }
    .project-open small,.project-library>.panel-head>span { color:var(--quiet); font-size:11px; }
    .project-status { justify-self:start; padding:3px 8px; border:1px solid #555646; border-radius:3px; color:#d6d5c7; font-size:10px; }
    .project-status.archived { color:var(--muted); }
    .project-card-actions { display:flex; gap:7px; padding-top:12px; border-top:1px solid var(--line); }
    .project-edit-button,.project-delete-button { min-height:32px; padding:5px 9px; font-size:11px; }
    .project-delete-button,.revoke-agent { border-color:#70483a; color:#e6aa8d; }
    .project-delete-button:hover,.revoke-agent:hover { background:#392820; }
    .project-edit-form,.project-relations { display:grid; gap:11px; margin-top:20px; padding:18px 0 0; border-top:1px solid var(--line); }
    .project-edit-form input,.project-edit-form textarea,.relation-form input,.relation-form select { width:100%; }
    .project-edit-form>div:last-child { display:flex; gap:8px; }
    .project-relations h3 { margin:0; font:600 18px 'Bricolage Grotesque',Georgia,serif; }
    .relation-form { display:grid; grid-template-columns:1fr 1fr 1.4fr auto; gap:8px; }
    .relation-form button { min-height:38px; padding:8px 12px; }
    .relation-row { display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); font-size:12px; }
    .relation-row span { color:var(--text); }
    .relation-row small { flex:1; color:var(--muted); }
    .relation-row button { border:0; background:transparent; color:#e6aa8d; font-size:20px; cursor:pointer; }
    .content-grid { display:grid; grid-template-columns:minmax(230px,.7fr) minmax(0,1.5fr); gap:14px; }
    .note-list { align-self:start; }
    .note-list h2 { margin:7px 0 12px; font:600 20px 'Bricolage Grotesque',Georgia,serif; }
    .note-row-wrap { display:flex; align-items:stretch; gap:5px; border-bottom:1px solid var(--line); }
    .note-row { display:grid; flex:1; min-width:0; gap:5px; padding:12px 8px; border:0; background:transparent; color:var(--text); text-align:left; cursor:pointer; }
    .note-row.selected,.note-row:hover { background:#303329; }
    .note-row strong { font-size:13px; }
    .note-row small { color:var(--muted); font-size:11px; }
    .note-delete { align-self:center; width:30px; height:30px; flex:none; border:1px solid #70483a; border-radius:5px; background:transparent; color:#e6aa8d; font-size:18px; cursor:pointer; }
    .new-note { margin-top:13px; }
    .note-editor { display:grid; align-content:start; gap:14px; }
    .note-title,.note-editor textarea { width:100%; padding:12px 13px; border:1px solid #555646; border-radius:6px; background:#1b1e19; color:var(--text); }
    .note-editor textarea { min-height:42vh; resize:vertical; line-height:1.65; }
    .note-meta { display:flex; gap:8px; }
    .primary { justify-self:end; }
    .image-library { margin-top:16px; }
    .image-library>p,.graph-hint { color:var(--muted); font-size:13px; line-height:1.55; }
    .upload { display:inline-flex; align-items:center; margin:12px 0 16px; }
    .upload input { display:none; }
    .image-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:12px; }
    .image-grid article { overflow:hidden; border:1px solid var(--line); border-radius:7px; background:#20231c; }
    .image-grid img { display:block; width:100%; height:155px; object-fit:cover; background:#1b1e19; }
    .image-grid article>div { display:grid; gap:5px; padding:11px; }
    .image-grid strong { overflow-wrap:anywhere; font-size:12px; }
    .image-grid small { color:var(--muted); font-size:11px; }
    .image-grid button { justify-self:start; padding:3px 0; border:0; background:transparent; color:#e6aa8d; cursor:pointer; font-size:11px; }
    .graph-workspace { margin-top:0; }
    .graph-hint { margin:13px 0; }
    .graph-canvas { height:min(68vh,720px); min-height:440px; overflow:hidden; border:1px solid var(--line); border-radius:8px; background:#1d201a; }
    .graph-detail { display:grid; gap:6px; margin-top:12px; padding:15px; border-left:2px solid var(--sage); background:#20231c; }
    .graph-detail strong { font-size:14px; }
    .graph-detail span,.graph-detail small { color:var(--muted); font-size:12px; }
    .graph-detail p { margin:0; color:#d0ccbf; font-size:13px; }
    .reconnect-banner,.alert { display:flex; align-items:center; gap:14px; width:min(1480px,calc(100% - 36px)); margin:14px auto 0; padding:12px 15px; border-radius:6px; font-size:13px; }
    .reconnect-banner { border:1px solid #806344; background:#2b281f; color:#e3c393; }
    .reconnect-banner span { flex:1; }
    .reconnect-banner button { padding:7px 10px; border:1px solid #806344; border-radius:5px; background:transparent; color:inherit; cursor:pointer; }
    .alert { justify-content:flex-start; }
    .error { border:1px solid #70483a; background:#30231f; color:#e8ae98; }
    .notice { border:1px solid #596447; background:#292d22; color:#d4d9bb; }
    .auth-shell { min-height:100vh; background:radial-gradient(ellipse at 50% 0,#34372b 0,transparent 48%),var(--bg); }
    .auth-shell.auth-hidden { display:none; }
    .auth-header { display:flex; align-items:center; justify-content:space-between; height:72px; padding:0 clamp(20px,5vw,64px); border-bottom:1px solid var(--line); background:#1d201a; }
    .auth-header .brand { padding:0; }
    .back-to-landing { color:var(--muted); text-decoration:none; font-size:13px; }
    .back-to-landing:hover { color:var(--text); }
    .auth-content { display:grid; min-height:calc(100vh - 72px); place-items:center; padding:30px 18px; }
    .connect-card { width:min(480px,100%); padding:32px; border:1px solid #4b4d3e; border-radius:10px; background:#24271f; }
    .connect-card h1 { margin-top:13px; font-size:34px; }
    .connect-card>p { font-size:14px; }
    .login-mark { display:block; width:58px; height:58px; margin-bottom:20px; object-fit:cover; border:1px solid #4b4d3e; border-radius:12px; }
    .auth-island-host { margin-top:23px; }
    :global(.mitpad-auth-form-wrap) { width:100%; padding-top:4px; }
    :global(.mitpad-auth-form) { display:grid; width:100%; gap:14px; }
    :global(.mitpad-auth-form label) { display:grid; gap:7px; color:#d5d1c4; font-size:13px; }
    :global(.mitpad-auth-form input) { width:100%; padding:11px 12px; border:1px solid #555646; border-radius:6px; background:#1b1e19; color:var(--text); }
    :global(.mitpad-auth-submit) { min-height:42px; border:0; border-radius:6px; background:var(--clay); color:#251b16; font-weight:650; cursor:pointer; }
    :global(.mitpad-auth-submit:hover) { background:#edb497; }
    :global(.mitpad-auth-switch),:global(.mitpad-auth-session button) { margin-top:12px; border:0; background:transparent; color:#e3a486; cursor:pointer; }
    :global(.mitpad-auth-footnote),:global(.mitpad-auth-status) { color:var(--muted); font-size:12px; line-height:1.55; }
    :global(.mitpad-auth-error) { display:block; margin-top:12px; color:#e8ae98; font-size:12px; overflow-wrap:anywhere; }
    :global(.mitpad-auth-session) { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .profile-backdrop { position:fixed; inset:0; z-index:20; display:grid; place-items:center; padding:18px; background:#0d0e0bcc; backdrop-filter:blur(8px); }
    .profile-dialog { width:min(680px,100%); max-height:92vh; overflow:auto; padding:0; border:1px solid var(--line); border-radius:10px; background:var(--panel); color:var(--text); }
    .profile-dialog>header { display:flex; align-items:center; justify-content:space-between; padding:18px 22px; border-bottom:1px solid var(--line); }
    .profile-dialog h2 { margin:5px 0 0; font:600 22px 'Bricolage Grotesque',Georgia,serif; }
    .profile-dialog .sign-out { min-height:34px; padding:6px 10px; border:1px solid var(--line); border-radius:5px; background:transparent; color:var(--muted); cursor:pointer; }
    .profile-dialog :global(.account-profile) { padding:22px; }
    .profile-dialog :global(.profile-avatar) { width:72px; height:72px; }
    .agent-connect-guide { display:grid; grid-template-columns:auto 1fr; gap:12px 14px; margin:20px 0; padding:17px; border-block:1px solid var(--line); }
    .guide-step { color:var(--clay); font:500 13px 'JetBrains Mono',monospace; }
    .agent-connect-guide strong { font-size:13px; }
    .agent-connect-guide p { margin:3px 0 0; color:var(--muted); font-size:12px; }
    .remote-agent-form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin:18px 0 24px; }
    .remote-agent-form label { display:grid; gap:6px; color:var(--muted); font-size:12px; }
    .remote-agent-form button { align-self:end; }
    .remote-agent-secret { display:grid; gap:12px; margin:18px 0; padding:17px; border:1px solid #686346; border-radius:7px; background:#2a2c22; }
    .remote-agent-secret p { margin:4px 0 0; color:var(--muted); font-size:12px; }
    .remote-agent-secret code { display:block; overflow-wrap:anywhere; padding:12px; border:1px solid var(--line); border-radius:5px; background:#1b1e19; color:#e3c99f; font-size:12px; }
    .agent-secret-actions { display:flex; flex-wrap:wrap; gap:8px; }
    .agent-secret-actions button { min-height:34px; padding:6px 10px; border:1px solid #555646; border-radius:5px; background:transparent; color:var(--text); cursor:pointer; }
    .agent-key-check { color:var(--sage)!important; }
    .agent-list-label { margin:24px 0 4px; padding-top:16px; border-top:1px solid var(--line); }
    .revoke-agent { min-height:31px; padding:5px 8px; font-size:11px; }
    .task-drop-targets { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:12px 0; }
    .task-drop-targets button { display:grid; min-height:44px; place-items:center; border:1px dashed #666852; border-radius:9px; background:transparent; color:var(--muted); font-size:12px; cursor:pointer; }
    .task-drop-targets button:hover { border-color:var(--sage); background:#2a2d24; color:var(--text); }
    .note-attachments { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px; }
    .note-attachments figure { overflow:hidden; margin:0; border:1px solid var(--line); border-radius:6px; }
    .note-attachments img { display:block; width:100%; height:110px; object-fit:cover; }
    .note-attachments figcaption { display:flex; justify-content:space-between; gap:8px; padding:7px 9px; color:var(--muted); font-size:11px; }
    .note-attachments figcaption button { border:0; background:transparent; color:#e6aa8d; cursor:pointer; }
    .note-upload { justify-self:start; }
    .note-attachments { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px; }
    .note-attachments figure { overflow:hidden; margin:0; border:1px solid var(--line); border-radius:6px; }
    .note-attachments img { display:block; width:100%; height:110px; object-fit:cover; }
    .note-attachments figcaption { display:flex; justify-content:space-between; gap:8px; padding:7px 9px; color:var(--muted); font-size:11px; }
    .note-attachments figcaption button { border:0; background:transparent; color:#e6aa8d; cursor:pointer; }
    .note-upload { justify-self:start; }
    .task-actions { display:flex; flex:none; align-items:center; gap:7px; }
    .task-open,.agent-edit-button { min-height:32px; padding:5px 9px; border:1px solid #555646; border-radius:5px; background:transparent; color:#e1ddcf; font-size:11px; cursor:pointer; }
    .task-open:hover,.agent-edit-button:hover { border-color:var(--sage); }
    .task-modal-backdrop { position:fixed; inset:0; z-index:30; display:grid; place-items:center; padding:18px; background:#0d0e0bcc; backdrop-filter:blur(7px); }
    .task-dialog { display:grid; width:min(760px,100%); max-height:92vh; gap:13px; overflow:auto; padding:22px; border:1px solid var(--line); border-radius:9px; background:#24271f; color:var(--text); }
    .task-dialog>header { display:flex; justify-content:space-between; align-items:center; gap:12px; padding-bottom:13px; border-bottom:1px solid var(--line); }
    .task-dialog h2 { margin:5px 0 0; font:600 22px 'Bricolage Grotesque',Georgia,serif; }
    .task-dialog>label,.task-detail-fields label,.agent-edit-form label { display:grid; gap:6px; color:var(--muted); font-size:12px; }
    .task-dialog input,.task-dialog textarea,.task-dialog select,.task-conversation select,.task-conversation textarea,.agent-edit-form input { width:100%; padding:10px 11px; border:1px solid #555646; border-radius:5px; background:#1b1e19; color:var(--text); }
    .task-detail-fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; }
    .task-dialog>.primary { justify-self:start; }
    .task-conversation { margin-top:6px; padding-top:15px; border-top:1px solid var(--line); }
    .task-conversation form { display:grid; gap:9px; margin-top:11px; }
    .task-conversation form .primary { justify-self:start; }
    .task-comment-list article { padding:12px 0; border-bottom:1px solid var(--line); }
    .task-comment-list article>div { display:flex; gap:9px; align-items:center; color:var(--muted); font-size:11px; }
    .task-comment-list article span { color:var(--clay); }
    .task-comment-list article time { margin-left:auto; color:var(--quiet); }
    .task-comment-list article p { margin:6px 0 0; white-space:pre-wrap; }
    .agent-edit-form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; padding:15px; border:1px solid var(--line); border-radius:7px; background:#20231c; }
    .agent-edit-form>strong,.agent-edit-form>div { grid-column:1/-1; }
    .agent-edit-form>div { display:flex; gap:8px; }
    @media (max-width:1000px) { .app-shell { grid-template-columns:220px minmax(0,1fr); } .workspace-grid { grid-template-columns:minmax(0,1fr); } .side-column { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:720px) {
        .app-shell { grid-template-columns:64px minmax(0,1fr); }
        .sidebar { padding:16px 7px 12px; }
        .sidebar .brand { justify-content:center; padding:0 0 23px; }
        .sidebar .brand>span,.sidebar .nav-label,.sidebar-projects,.sidebar-bottom .pilot-text,.cloud-indicator,.nav-text,.nav-count { display:none; }
        .workspace-nav button { justify-content:center; padding:11px 4px; font-size:0; }
        .workspace-nav button>span:first-child { width:auto; font-size:17px; }
        .sidebar-bottom { justify-content:center; padding:12px 0 0; }
        .pilot-avatar { width:34px; height:34px; }
        .topbar { min-height:58px; padding:0 13px; }
        .top-actions { gap:4px; }
        .sync-pill { display:none; }
        .secondary,.avatar-button { min-height:33px; padding:5px 8px; font-size:11px; }
        .dashboard { padding:24px 14px 48px; }
        .intro { align-items:flex-start; flex-direction:column; gap:14px; }
        .last-sync { text-align:left; }
        .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .side-column { grid-template-columns:minmax(0,1fr); }
        .work-panel { padding:16px; }
        .panel-head { align-items:flex-start; flex-direction:column; }
        .panel-head select { width:100%; }
        .task { align-items:flex-start; flex-direction:column; }
        .task select { margin-left:20px; }
        .content-grid { grid-template-columns:minmax(0,1fr); }
        .note-editor textarea { min-height:32vh; }
        .relation-form { grid-template-columns:minmax(0,1fr); }
        .relation-row { align-items:flex-start; flex-wrap:wrap; }
        .relation-row small { flex-basis:70%; }
        .connect-card { padding:23px; }
        .auth-header { height:60px; padding:0 14px; }
        .auth-header .brand { font-size:18px; }
        .back-to-landing { font-size:11px; }
        .auth-content { min-height:calc(100vh - 60px); padding:20px 14px; }
        .remote-agent-form,.agent-edit-form,.task-detail-fields { grid-template-columns:minmax(0,1fr); }
        .task-actions { flex-wrap:wrap; }
        .task-dialog { padding:16px; }
        .task-actions { flex-wrap:wrap; }
        .task-dialog { padding:16px; }
        .task-actions { flex-wrap:wrap; }
        .task-dialog { padding:16px; }
        .graph-canvas { min-height:380px; height:55vh; }
    }
    @media (max-width:420px) { .app-shell { grid-template-columns:52px minmax(0,1fr); } .sidebar { padding-inline:4px; } .top-actions .secondary:nth-of-type(1) { display:none; } .breadcrumbs { gap:6px; font-size:11px; } .project-grid { grid-template-columns:minmax(0,1fr); } .summary-grid article { padding:13px; } }
    @media (prefers-reduced-motion:reduce) { :global(*),:global(*::before),:global(*::after) { scroll-behavior:auto!important; animation-duration:.01ms!important; transition-duration:.01ms!important; } }
</style>
