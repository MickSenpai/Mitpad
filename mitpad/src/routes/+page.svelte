<script lang="ts">
    import { onMount, tick } from 'svelte';
    import type { Clerk as ClerkClient } from '@clerk/clerk-js';
    import { ui } from '@clerk/ui';
    import { PUBLIC_CONVEX_URL } from '$env/static/public';
    import ThreeDGraph from '$lib/ThreeDGraph.svelte';
    import WebWorkbench from '$lib/WebWorkbench.svelte';
    import {
        createProject, listProjects, createTask, listTasks, updateTask,
        listProjectLinks, createProjectLink, deleteProjectLink,
        createTaskComment, listTaskComments, listActivity, createLocalAgent,
        listAgents, createLocalNote, updateLocalNote,
        listLocalNotes, getSyncStatus, saveNoteImage, listNoteImages,
        readNoteImage, deleteNoteImage, saveProjectImage, listProjectImages,
        readProjectImage, deleteProjectImage, syncWorkbenchNow, updateLocalAgent,
        deleteLocalAgent, markNoteAttended, retryFailedSync,
        type Project, type ProjectLink, type Task, type TaskComment, type ActivityEvent,
        type Agent, type Note, type SyncStatus, type NoteImage, type ProjectImage, type ProjectKnowledge, listProjectKnowledge
    } from '$lib/ipc';
    import { USER_ID } from '$lib/config';

    type View = 'projects' | 'tasks' | 'memory' | 'images' | 'activity' | 'agents' | 'graph';
    const stages: { id: Task['status']; label: string }[] = [
        { id: 'backlog', label: 'Pendiente' }, { id: 'todo', label: 'Por hacer' },
        { id: 'in_progress', label: 'En curso' }, { id: 'review', label: 'Revisión' }, { id: 'blocked', label: 'Bloqueado' },
        { id: 'done', label: 'Hecho' }
    ];
    const types: TaskComment['comment_type'][] = ['message', 'instruction', 'question', 'answer', 'decision', 'update'];

    let view: View = 'projects';
    let projects: Project[] = [];
    let projectLinks: ProjectLink[] = [];
    let relationSource = '';
    let relationTarget = '';
    let relationType: ProjectLink['relation_type'] = 'related_to';
    let relationDescription = '';
    let selectedProjectId = '';
    let tasks: Task[] = [];
    let selectedTask: Task | null = null;
    let comments: TaskComment[] = [];
    let events: ActivityEvent[] = [];
    let agents: Agent[] = [];
    let editingAgentId = '';
    let taskAssignee = '';
    let graphTasks: Task[] = [];
    type GraphNode = { id: string; label: string; kind: 'project' | 'task' | 'knowledge'; projectId: string; x: number; y: number; z: number; status?: string; knowledgeKind?: ProjectKnowledge['kind']; summary?: string; source?: string; tags?: string[] };
    let graphNodes: GraphNode[] = [];
    let graphKnowledge: ProjectKnowledge[] = [];
    let selectedKnowledge: ProjectKnowledge | null = null;
    let graphFilter: 'all' | 'projects' | 'tasks' | 'knowledge' = 'all';
    let graphProjectFilter = '';
    let graphSearch = '';
    let isDesktop = false;
    let clerk: ClerkClient | null = null;
    let signInNode: HTMLDivElement;
    let signInMounted = false;
    let signUpMounted = false;
    let desktopAuthLoaded = false;
    let desktopAuthenticated = false;
    let desktopEmail = '';
    let showProfile = false;
    let profileNode: HTMLDivElement;
    let profileMounted = false;
    let notes: Note[] = [];
    let selectedNote: Note | null = null;
    let status: SyncStatus | null = null;
    let noteImages: NoteImage[] = [];
    let imageUrls: Record<string, string> = {};
    let imageNotice = '';
    let projectImages: ProjectImage[] = [];
    let projectImageUrls: Record<string, string> = {};
    let projectImageNotice = '';
    let error = '';
    let notice = '';
    let busy = false;

    let projectName = '';
    let projectDescription = '';
    let taskTitle = '';
    let taskDescription = '';
    let taskPriority: Task['priority'] = 'medium';
    let taskStatus: Task['status'] = 'todo';
    let commentType: TaskComment['comment_type'] = 'update';
    let commentText = '';
    let agentName = '';
    let agentModel = '';
    let agentProvider = '';
    let agentClient = 'codex';
    let noteTitle = '';
    let noteContent = '';
    let search = '';

    $: activeProject = projects.find((p) => p.id === selectedProjectId) ?? null;
    $: selectedKnowledgeProject = projects.find((project) => project.id === selectedKnowledge?.project_id)?.name ?? '';
    $: visibleProjects = projects.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(search.trim().toLowerCase()));
    $: visibleTasks = tasks.filter((t) => `${t.title} ${t.description}`.toLowerCase().includes(search.trim().toLowerCase()));
    $: visibleGraphNodes = graphNodes.filter((node) => {
        const filterMatches = graphFilter === 'all' || graphFilter === 'projects' && node.kind === 'project' || graphFilter === 'tasks' && (node.kind === 'project' || node.kind === 'task') || graphFilter === 'knowledge' && (node.kind === 'project' || node.kind === 'knowledge');
        const projectMatches = !graphProjectFilter || node.projectId === graphProjectFilter;
        const query = graphSearch.trim().toLowerCase();
        const matchesSearch = !query || `${node.label} ${node.summary ?? ''} ${(node.tags ?? []).join(' ')}`.toLowerCase().includes(query);
        const neededAsParent = node.kind === 'project' && !!query && graphNodes.some((child) => child.projectId === node.id && child.kind !== 'project' && filterMatches && `${child.label} ${child.summary ?? ''} ${(child.tags ?? []).join(' ')}`.toLowerCase().includes(query));
        return filterMatches && projectMatches && (matchesSearch || neededAsParent);
    });
    $: visibleGraphLinks = projectLinks.filter((link) => !graphProjectFilter || link.source_project_id === graphProjectFilter || link.target_project_id === graphProjectFilter);

    onMount(() => {
        isDesktop = '__TAURI_INTERNALS__' in window;
        let autoSync: ReturnType<typeof setInterval> | undefined;
        if (isDesktop) {
            void initializeDesktopAuth();
            autoSync = setInterval(() => {
                if (document.visibilityState === 'visible' && desktopAuthenticated && !busy) void syncNow(true);
            }, 300_000);
        }
        window.addEventListener('hashchange', handleAuthRoute);
        return () => { window.removeEventListener('hashchange', handleAuthRoute); if (autoSync) clearInterval(autoSync); clearImageUrls(); clearProjectImageUrls(); if (clerk && signInMounted && signInNode) clerk.unmountSignIn(signInNode); if (clerk && signUpMounted && signInNode) clerk.unmountSignUp(signInNode); if (clerk && profileMounted && profileNode) clerk.unmountUserProfile(profileNode); };
    });

    async function initializeDesktopAuth() {
        try {
            if (!PUBLIC_CONVEX_URL || !import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) throw new Error('Falta PUBLIC_CONVEX_URL o VITE_CLERK_PUBLISHABLE_KEY.');
            const { Clerk } = await import('@clerk/clerk-js');
            clerk = new Clerk(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
            await clerk.load({ ui });
            clerk.addListener(() => { void syncDesktopIdentity(); });
            await syncDesktopIdentity();
        } catch (e) { error = `No se pudo iniciar Clerk: ${e}`; desktopAuthLoaded = true; }
    }

    async function syncDesktopIdentity() {
        if (!clerk) return;
        if (!clerk.session) {
            desktopAuthenticated = false;
            desktopEmail = '';
            // Render the signed-out branch first so bind:this has created the
            // mount target before Clerk tries to attach its sign-in UI.
            desktopAuthLoaded = true;
            await tick();
            await tick();
            await mountAuthComponent();
            return;
        }
        try {
            const wasAuthenticated = desktopAuthenticated;
            const token = await clerk.session.getToken();
            if (!token) throw new Error('Clerk no entregó un token de sesión.');
            desktopEmail = clerk.user?.primaryEmailAddress?.emailAddress ?? 'Cuenta Clerk';
            desktopAuthenticated = true;
            desktopAuthLoaded = true;
            if (signInMounted && signInNode) { clerk.unmountSignIn(signInNode); signInMounted = false; }
            if (signUpMounted && signInNode) { clerk.unmountSignUp(signInNode); signUpMounted = false; }
            status = { ...(status ?? { pending: 0, failed: 0, last_error: null, last_sync_at: null }), configured: true };
            if (!wasAuthenticated) {
                await loadWorkspace();
                await syncNow(true);
            }
        } catch (e) { desktopAuthenticated = false; desktopAuthLoaded = true; error = `No se autorizó el acceso al workspace: ${e}`; }
    }

    function handleAuthRoute() {
        if (!clerk?.session) void mountAuthComponent();
    }

    async function mountAuthComponent() {
        if (!clerk || !signInNode) return;
        const wantsSignUp = window.location.hash.startsWith('#/sign-up');
        if ((wantsSignUp && signUpMounted) || (!wantsSignUp && signInMounted)) return;
        if (signInMounted) { clerk.unmountSignIn(signInNode); signInMounted = false; }
        if (signUpMounted) { clerk.unmountSignUp(signInNode); signUpMounted = false; }
        const appearance = { options: { socialButtonsPlacement: 'top', socialButtonsVariant: 'blockButton' }, variables: { colorPrimary: '#95e8d3', colorPrimaryForeground: '#101917', colorBackground: '#111820', colorForeground: '#f1f5f9', colorMutedForeground: '#b9c5d0', colorInput: '#0b1118', colorInputForeground: '#f1f5f9', colorBorder: '#35414e', colorNeutral: '#35414e', colorRing: '#80dfc5', borderRadius: '0.6rem' } };
        if (wantsSignUp) {
            clerk.mountSignUp(signInNode, { routing: 'hash', signInUrl: '#/sign-in', appearance });
            signUpMounted = true;
        } else {
            clerk.mountSignIn(signInNode, { routing: 'hash', signUpUrl: '#/sign-up', appearance });
            signInMounted = true;
        }
    }

    async function signOutDesktop() { await clerk?.signOut(); }

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

    async function loadWorkspace() {
        try {
            [projects, projectLinks, agents, notes, status] = await Promise.all([listProjects(), listProjectLinks(), listAgents(), listLocalNotes(), getSyncStatus()]);
            relationSource = projects[0]?.id ?? '';
            relationTarget = projects.find((project) => project.id !== relationSource)?.id ?? '';
            if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) await loadProject(selectedProjectId);
            else if (projects.length) await loadProject(projects[0].id);
            else selectedProjectId = '';
        } catch (e) { error = `No se pudo cargar Mitpad: ${e}`; }
    }

    async function syncNow(automatic = false) {
        if (busy || (automatic && document.visibilityState !== 'visible')) return;
        busy = true; error = ''; notice = '';
        try {
            if (!clerk?.session || !PUBLIC_CONVEX_URL) throw new Error('Inicia sesión con Clerk antes de sincronizar.');
            const token = await clerk.session.getToken();
            if (!token) throw new Error('Clerk no entregó un token de sesión.');
            await retryFailedSync();
            const sent = await syncWorkbenchNow(PUBLIC_CONVEX_URL, token);
            await loadWorkspace();
            status = { ...(await getSyncStatus()), configured: true };
            if (!automatic) notice = sent ? `Sincronización completada: ${sent} registros enviados.` : 'No había cambios pendientes para enviar.';
        } catch (e) { error = `No se pudo sincronizar: ${e}`; }
        finally { busy = false; }
    }

    async function addProjectRelation() {
        if (!relationSource || !relationTarget || relationSource === relationTarget) return;
        busy = true; error = ''; notice = '';
        try {
            await createProjectLink(relationSource, relationTarget, relationType, relationDescription);
            projectLinks = await listProjectLinks();
            relationDescription = '';
            notice = 'Relación entre proyectos guardada en este equipo.';
        } catch (e) { error = `No se pudo relacionar los proyectos: ${e}`; }
        finally { busy = false; }
    }

    async function removeProjectRelation(id: string) {
        try { const token = await clerk?.session?.getToken(); if (!token || !PUBLIC_CONVEX_URL) throw new Error('Inicia sesión con Clerk para cambiar relaciones.'); await deleteProjectLink(id, PUBLIC_CONVEX_URL, token); projectLinks = await listProjectLinks(); }
        catch (e) { error = `No se pudo quitar la relación: ${e}`; }
    }

    async function openGraph() {
        view = 'graph';
        try {
            if (graphProjectFilter && !projects.some((project) => project.id === graphProjectFilter)) graphProjectFilter = '';
            const token = await clerk?.session?.getToken();
            if (!token || !PUBLIC_CONVEX_URL) throw new Error('Inicia sesión con Clerk para cargar el mapa compartido.');
            projectLinks = await listProjectLinks();
            const [groups, knowledge] = await Promise.all([
                Promise.all(projects.map((project) => listTasks(project.id))),
                listProjectKnowledge(PUBLIC_CONVEX_URL, token)
            ]);
            graphTasks = groups.flat();
            graphKnowledge = knowledge;
            selectedKnowledge = null;
            const radius = Math.max(230, projects.length * 72);
            graphNodes = projects.flatMap((project, index) => {
                const angle = (index / Math.max(projects.length, 1)) * Math.PI * 2;
                const x = Math.cos(angle) * radius;
                const z = Math.sin(angle) * radius;
                const projectNode: GraphNode = { id: project.id, label: project.name, kind: 'project', projectId: project.id, x, y: 0, z };
                const children = graphTasks.filter((task) => task.project_id === project.id);
                const facts = graphKnowledge.filter((item) => item.project_id === project.id);
                const taskNodes = children.map((task, child) => {
                    const childAngle = child * 2.399 + angle;
                    const childRadius = 100 + (Math.floor(child / 7) * 28);
                    return { id: task.id, label: task.title, kind: 'task' as const, projectId: project.id, x: x + Math.cos(childAngle) * childRadius, y: 105 + Math.floor(child / 7) * 55, z: z + Math.sin(childAngle) * childRadius, status: task.status };
                });
                const knowledgeNodes = facts.map((item, child) => {
                    const childAngle = child * 2.399 + angle + Math.PI / 5;
                    const childRadius = 118 + (Math.floor(child / 8) * 35);
                    return { id: `knowledge:${item.id}`, label: item.title, kind: 'knowledge' as const, projectId: project.id, x: x + Math.cos(childAngle) * childRadius, y: -100 - Math.floor(child / 8) * 52, z: z + Math.sin(childAngle) * childRadius, knowledgeKind: item.kind, summary: item.summary, source: item.source, tags: item.tags };
                });
                return [projectNode, ...taskNodes, ...knowledgeNodes];
            });
        } catch (e) { error = `No se pudo construir el mapa: ${e}`; }
    }

    async function openGraphNode(node: GraphNode) {
        if (node.kind === 'knowledge') {
            selectedKnowledge = graphKnowledge.find((item) => `knowledge:${item.id}` === node.id) ?? null;
            return;
        }
        selectedKnowledge = null;
        if (node.kind === 'project') { await loadProject(node.projectId); view = 'tasks'; return; }
        await loadProject(node.projectId);
        const task = graphTasks.find((item) => item.id === node.id);
        if (task) await openTask(task);
        view = 'tasks';
    }

    async function loadProject(id: string) {
        selectedProjectId = id;
        try {
            tasks = await listTasks(id);
            events = await listActivity(id);
            if (selectedTask && !tasks.some((t) => t.id === selectedTask?.id)) selectedTask = null;
        } catch (e) { error = `No se pudo abrir el proyecto: ${e}`; }
    }

    async function openImageLibrary() {
        view = 'images';
        projectImageNotice = '';
        if (!selectedProjectId && projects.length) selectedProjectId = projects[0].id;
        if (selectedProjectId) await loadProjectImages(selectedProjectId);
        else { clearProjectImageUrls(); projectImages = []; }
    }

    function clearProjectImageUrls() {
        Object.values(projectImageUrls).forEach((url) => URL.revokeObjectURL(url));
        projectImageUrls = {};
    }

    async function loadProjectImages(projectId: string) {
        clearProjectImageUrls();
        projectImageNotice = '';
        try {
            projectImages = await listProjectImages(projectId);
            const urls: Record<string, string> = {};
            for (const image of projectImages) {
                urls[image.id] = URL.createObjectURL(new Blob([await readProjectImage(image.id)], { type: image.content_type }));
            }
            projectImageUrls = urls;
        } catch (e) { projectImageNotice = `No se pudieron cargar las imágenes: ${e}`; }
    }

    async function selectImageProject(event: Event) {
        selectedProjectId = (event.currentTarget as HTMLSelectElement).value;
        if (selectedProjectId) await loadProjectImages(selectedProjectId);
        else { clearProjectImageUrls(); projectImages = []; }
    }

    async function addProjectImages(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const files = Array.from(input.files ?? []);
        input.value = '';
        if (!selectedProjectId || !files.length) return;
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        const invalid = files.find((file) => !allowed.includes(file.type));
        if (invalid) { projectImageNotice = `Formato no admitido: ${invalid.name}. Usa JPEG, PNG, WebP o GIF.`; return; }
        const oversized = files.find((file) => file.size > 10 * 1024 * 1024);
        if (oversized) { projectImageNotice = `${oversized.name} supera el límite de 10 MB.`; return; }
        busy = true;
        projectImageNotice = '';
        let syncAfterSave = false;
        try {
            for (const file of files) {
                await saveProjectImage(selectedProjectId, file.name, file.type, new Uint8Array(await file.arrayBuffer()));
            }
            await loadProjectImages(selectedProjectId);
            syncAfterSave = desktopAuthenticated;
            notice = files.length === 1 ? 'Imagen guardada en la galería del proyecto.' : `${files.length} imágenes guardadas en la galería del proyecto.`;
        } catch (e) {
            const message = `${e}`;
            await loadProjectImages(selectedProjectId);
            projectImageNotice = message;
        } finally { busy = false; if (syncAfterSave) void syncNow(true); }
    }

    async function removeProjectImage(image: ProjectImage) {
        if (!window.confirm(`¿Borrar “${image.filename}” de este proyecto?`)) return;
        busy = true;
        try {
            await deleteProjectImage(image.id);
            await loadProjectImages(selectedProjectId);
            notice = 'Imagen borrada.';
        } catch (e) { projectImageNotice = `${e}`; }
        finally { busy = false; }
    }

    async function newProject() {
        error = ''; notice = ''; busy = true;
        try {
            const project = await createProject(projectName, projectDescription);
            projects = [project, ...projects]; projectName = ''; projectDescription = '';
            selectedProjectId = project.id; tasks = []; view = 'tasks'; notice = 'Proyecto creado.';
            events = await listActivity(project.id);
        } catch (e) { error = `${e}`; } finally { busy = false; }
    }

    async function newTask() {
        if (!selectedProjectId) return;
        error = ''; busy = true;
        try {
            const task = await createTask(selectedProjectId, taskTitle, taskDescription, taskPriority, taskAssignee || null);
            tasks = [task, ...tasks]; taskTitle = ''; taskDescription = ''; taskPriority = 'medium';
            taskAssignee = '';
            selectedTask = task; taskStatus = task.status; comments = [];
            events = await listActivity(selectedProjectId); notice = 'Tarea creada.';
        } catch (e) { error = `${e}`; } finally { busy = false; }
    }

    async function moveTask(task: Task, status: Task['status']) {
        if (task.status === status) return;
        try {
            const saved = await updateTask({ ...task, status });
            tasks = tasks.map((item) => item.id === saved.id ? saved : item);
            if (selectedTask?.id === saved.id) { selectedTask = saved; taskStatus = saved.status; }
            events = await listActivity(selectedProjectId);
        } catch (e) { error = `No se pudo mover la tarea: ${e}`; }
    }

    function editAgent(agent: Agent) {
        editingAgentId = agent.id; agentName = agent.name; agentModel = agent.model ?? '';
        agentProvider = agent.provider ?? ''; agentClient = agent.client_type ?? 'other';
    }

    async function removeAgent(agent: Agent) {
        if (agent.id === 'meido-primary-agent' || !window.confirm(`¿Desactivar a ${agent.name}? Se conservará su historial.`)) return;
        busy = true;
        try { await deleteLocalAgent(agent.id); agents = await listAgents(); notice = `Agente ${agent.name} desactivado.`; }
        catch (e) { error = `${e}`; } finally { busy = false; }
    }

    async function attendNote() {
        if (!selectedNote) return;
        busy = true;
        try { selectedNote = await markNoteAttended(selectedNote.id); notes = await listLocalNotes(); notice = 'Nota marcada como atendida; se conserva en Memoria.'; status = await getSyncStatus(); }
        catch (e) { error = `${e}`; } finally { busy = false; }
    }

    async function openTask(task: Task) {
        selectedTask = { ...task }; taskStatus = task.status;
        try { comments = await listTaskComments(task.id); } catch (e) { error = `${e}`; }
    }

    async function saveTask() {
        if (!selectedTask) return;
        busy = true; error = '';
        try {
            const saved = await updateTask({ ...selectedTask, status: taskStatus });
            tasks = tasks.map((t) => t.id === saved.id ? saved : t);
            selectedTask = saved; events = await listActivity(selectedProjectId); notice = 'Cambios de tarea guardados.';
        } catch (e) { error = `${e}`; } finally { busy = false; }
    }

    async function addComment() {
        if (!selectedTask) return;
        busy = true; error = '';
        try {
            const comment = await createTaskComment(selectedTask.id, commentType, commentText);
            comments = [comment, ...comments]; commentText = '';
            events = await listActivity(selectedProjectId); notice = 'Comentario añadido al historial.';
        } catch (e) { error = `${e}`; } finally { busy = false; }
    }

    async function saveAgent() {
        busy = true; error = '';
        try {
            if (editingAgentId) {
                const existing = agents.find((agent) => agent.id === editingAgentId);
                if (!existing) throw new Error('No se encontró el agente seleccionado.');
                const saved = await updateLocalAgent({ ...existing, name: agentName, model: agentModel || null, provider: agentProvider || null, client_type: agentClient });
                agents = agents.map((agent) => agent.id === saved.id ? saved : agent);
                notice = 'Agente actualizado.';
            } else {
                agents = [await createLocalAgent(agentName, agentModel, agentProvider, agentClient), ...agents];
                notice = 'Agente registrado en este equipo.';
            }
            editingAgentId = ''; agentName = ''; agentModel = ''; agentProvider = ''; agentClient = 'codex';
        } catch (e) { error = `${e}`; } finally { busy = false; }
    }

    async function openNote(note: Note) {
        selectedNote = note; noteTitle = note.title ?? ''; noteContent = note.content;
        await loadNoteImages(note.id);
    }

    function newNote() { selectedNote = null; noteTitle = ''; noteContent = ''; clearImageUrls(); noteImages = []; }

    function clearImageUrls() { Object.values(imageUrls).forEach((url) => URL.revokeObjectURL(url)); imageUrls = {}; }

    async function loadNoteImages(noteId: string) {
        clearImageUrls(); imageNotice = '';
        try {
            noteImages = await listNoteImages(noteId);
            const urls: Record<string, string> = {};
            for (const image of noteImages) {
                urls[image.id] = URL.createObjectURL(new Blob([await readNoteImage(image.id)], { type: image.content_type }));
            }
            imageUrls = urls;
        } catch (e) { imageNotice = `No se pudieron cargar las imágenes: ${e}`; }
    }

    async function addImage(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0]; input.value = '';
        if (!file || !selectedNote) return;
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) { imageNotice = 'Usa una imagen JPEG, PNG, WebP o GIF.'; return; }
        if (file.size > 10 * 1024 * 1024) { imageNotice = 'La imagen supera el límite de 10 MB.'; return; }
        busy = true; imageNotice = '';
        let syncAfterSave = false;
        try {
            await saveNoteImage(selectedNote.id, file.name, file.type, new Uint8Array(await file.arrayBuffer()));
            await loadNoteImages(selectedNote.id);
            syncAfterSave = desktopAuthenticated;
            imageNotice = desktopAuthenticated ? 'Imagen guardada; sincronizando con la nube…' : 'Imagen guardada localmente y disponible sin conexión.';
            status = await getSyncStatus();
        } catch (e) { imageNotice = `${e}`; } finally { busy = false; if (syncAfterSave) void syncNow(true); }
    }

    async function removeImage(id: string) {
        if (!selectedNote || !window.confirm('Borrar esta imagen?')) return;
        busy = true;
        try { await deleteNoteImage(id); await loadNoteImages(selectedNote.id); status = await getSyncStatus(); }
        catch (e) { imageNotice = `${e}`; } finally { busy = false; }
    }

    async function saveNote() {
        error = ''; busy = true;
        try {
            if (selectedNote) selectedNote = await updateLocalNote(selectedNote.id, noteTitle, noteContent);
            else selectedNote = await createLocalNote(noteTitle, noteContent, USER_ID);
            notes = await listLocalNotes(); status = await getSyncStatus(); notice = 'Memoria guardada localmente.';
        } catch (e) { error = `${e}`; } finally { busy = false; }
    }

    function formatDate(time: number) { return new Date(time).toLocaleString(); }
    function labelStatus(value: Task['status']) { return stages.find((s) => s.id === value)?.label ?? value; }
</script>

<svelte:head>
    <title>Mitpad · Agent Workbench</title>
    <meta name="description" content="Memoria y espacio de trabajo compartido para tus agentes." />
</svelte:head>

{#if !isDesktop}
    <WebWorkbench />
{:else if !desktopAuthLoaded}
    <main class="desktop-auth-screen"><section class="desktop-auth-card"><div class="brand-mark">M</div><h1>Conectando con Clerk</h1><p>Preparando el acceso seguro a tu workspace.</p></section></main>
{:else if !desktopAuthenticated}
    <main class="desktop-auth-screen"><section class="desktop-auth-card"><div class="eyebrow">MITPAD · ACCESO SEGURO</div><h1>Inicia sesión</h1><p>Usa la misma cuenta Clerk que en la versión web para abrir tu workspace compartido.</p><div class="desktop-clerk-widget" bind:this={signInNode}></div>{#if error}<small class="desktop-auth-error">{error}</small>{/if}</section></main>
{:else}
<div class="app-shell">
    <aside class="sidebar">
        <a class="brand" href="/" aria-label="Mitpad inicio"><span class="brand-mark">M</span><span>mitpad<small>AGENT WORKBENCH</small></span></a>
        <div class="sidebar-scroll">
        <div class="nav-label">WORKSPACE</div>
        <nav>
            <button class:active={view === 'projects'} on:click={() => view = 'projects'}><span>▦</span> Proyectos</button>
            <button class:active={view === 'tasks'} on:click={() => view = 'tasks'} disabled={!activeProject}><span>☷</span> Tablero</button>
            <button class:active={view === 'memory'} on:click={() => view = 'memory'}><span>◈</span> Memoria</button>
            <button class:active={view === 'images'} on:click={() => void openImageLibrary()}><span>▧</span> Imágenes</button>
            <button class:active={view === 'activity'} on:click={() => view = 'activity'}><span>◷</span> Actividad</button>
            <button class:active={view === 'agents'} on:click={() => view = 'agents'}><span>⌘</span> Agentes</button>
            <button class:active={view === 'graph'} on:click={() => void openGraph()}><span>⌘</span> Mapa</button>
        </nav>
        <div class="sidebar-projects">
            <div class="nav-label">PROYECTOS <button title="Crear proyecto" on:click={() => view = 'projects'}>＋</button></div>
            {#each projects.slice(0, 8) as project (project.id)}
                <button class:project-active={selectedProjectId === project.id} class="project-link" on:click={() => { void loadProject(project.id); view = 'tasks'; }}><span class="project-dot"></span>{project.name}</button>
            {/each}
            {#if projects.length === 0}<p class="side-empty">Crea tu primer proyecto.</p>{/if}
        </div>
        </div>
        <div class="sidebar-bottom">
            <div class="pilot-avatar">P</div><div class="pilot-text"><strong>Piloto</strong><small>Espacio personal</small></div>
            <span class:cloud-on={status?.configured} class="cloud-indicator" title={status?.configured ? 'Nube configurada' : 'Solo almacenamiento local'}>●</span>
        </div>
    </aside>

    <main class="main-area">
        <header class="topbar">
            <div class="breadcrumbs"><span>Workspace</span>{#if activeProject}<span class="crumb-sep">/</span><strong>{activeProject.name}</strong>{/if}</div>
            <div class="top-actions"><span class="user-email">{desktopEmail}</span><span class="sync-pill" title={status?.last_error ?? (status?.last_sync_at ? `Última sincronización ${new Date(status.last_sync_at).toLocaleString()}` : 'Sincronización automática cada 5 minutos')}>{#if status?.configured}{#if status.failed > 0}⚠ {status.failed} fallidos{:else if status.pending > 0}{status.pending} pendientes{:else}● Sincronizado{/if}{:else}● Local{/if}</span><button class="secondary" on:click={() => void syncNow()} disabled={busy || !desktopAuthenticated}>{busy ? 'Sincronizando…' : 'Sincronizar'}</button><button class="secondary" on:click={() => void openProfile()}>Perfil</button><button class="avatar-button" title="Cerrar sesión de Clerk" on:click={() => void signOutDesktop()}>Salir</button></div>
        </header>

        {#if error}<div class="toast error-toast">{error}<button on:click={() => error = ''}>×</button></div>{/if}
        {#if notice}<div class="toast notice-toast">{notice}<button on:click={() => notice = ''}>×</button></div>{/if}

        {#if view === 'projects'}
            <section class="page-content">
                <div class="page-heading"><div><p class="eyebrow">TU ESPACIO DE TRABAJO</p><h1>Proyectos</h1><p class="subtitle">Un lugar compartido para organizar el trabajo y el contexto de tus agentes.</p></div><div class="heading-icon">▦</div></div>
                <div class="project-create panel">
                    <div><h2>Crear proyecto</h2><p>Empieza con un proyecto y dale contexto persistente a tus agentes.</p></div>
                    <div class="project-form"><input bind:value={projectName} placeholder="Nombre del proyecto" maxlength="160" /><input bind:value={projectDescription} placeholder="Descripción y objetivo" maxlength="20000" /><button class="primary" on:click={newProject} disabled={busy || !projectName.trim()}>Crear proyecto <span>↗</span></button></div>
                </div>
                {#if projects.length > 1}
                    <div class="project-relations panel">
                        <div><h2>Relacionar proyectos</h2><p>Conecta proyectos para ver cómo se organiza el trabajo.</p></div>
                        <div class="relation-form">
                            <select aria-label="Proyecto origen" bind:value={relationSource}><option value="">Proyecto origen</option>{#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}</select>
                            <select aria-label="Tipo de relación" bind:value={relationType}><option value="related_to">Relacionado con</option><option value="parent_of">Proyecto principal de</option><option value="depends_on">Depende de</option></select>
                            <select aria-label="Proyecto destino" bind:value={relationTarget}><option value="">Proyecto destino</option>{#each projects as project (project.id)}<option value={project.id} disabled={project.id === relationSource}>{project.name}</option>{/each}</select>
                            <input class="relation-description" bind:value={relationDescription} maxlength="1000" placeholder="¿Qué los relaciona?" aria-label="Descripción de la relación" />
                            <button class="secondary" on:click={addProjectRelation} disabled={busy || !relationSource || !relationTarget || relationSource === relationTarget}>＋ Relacionar</button>
                        </div>
                        {#if projectLinks.length}<div class="relation-list">{#each projectLinks as link (link.id)}{@const source = projects.find((p) => p.id === link.source_project_id)}{@const target = projects.find((p) => p.id === link.target_project_id)}<span><strong>{source?.name ?? 'Proyecto'} <small>{link.relation_type === 'parent_of' ? 'es principal de' : link.relation_type === 'depends_on' ? 'depende de' : 'relacionado con'}</small> {target?.name ?? 'Proyecto'}</strong>{#if link.description}<small class="relation-explanation">{link.description}</small>{/if}<button aria-label="Quitar relación" on:click={() => void removeProjectRelation(link.id)}>×</button></span>{/each}</div>{/if}
                    </div>
                {/if}
                <div class="section-title"><h2>Todos los proyectos</h2><span>{projects.length} proyectos</span></div>
                <div class="project-grid">
                    {#each visibleProjects as project (project.id)}
                        <button class="project-card panel" on:click={() => { void loadProject(project.id); view = 'tasks'; }}>
                            <div class="project-card-top"><span class="project-icon">▦</span><span class="card-arrow">↗</span></div>
                            <h3>{project.name}</h3><p>{project.description || 'Sin descripción todavía.'}</p>
                            <div class="project-card-foot"><span><i></i> Activo</span><span>{tasks.filter((t) => t.project_id === project.id).length} tareas</span></div>
                        </button>
                    {/each}
                </div>
                {#if projects.length === 0}<div class="empty-state panel"><span>▦</span><h2>Aquí empieza tu trabajo</h2><p>Crea un proyecto para agrupar tareas, contexto, notas y actividad.</p></div>{/if}
            </section>
        {:else if view === 'tasks'}
            <section class="page-content">
                <div class="page-heading task-heading"><div><p class="eyebrow">{activeProject?.name ?? 'PROYECTO'}</p><h1>Tablero de trabajo</h1><p class="subtitle">Arrastra las tarjetas entre columnas para cambiar su estado.</p></div><div class="heading-actions"><input class="search" bind:value={search} placeholder="Buscar tareas…" /></div></div>
                {#if selectedTask || !selectedTask}
                    <div class="task-workspace">
                        <div class="board">
                            {#each stages as stage (stage.id)}
                                <div role="region" aria-label={`Mover tarea a ${stage.label}`} class="column" on:dragover={(event) => event.preventDefault()} on:drop={(event) => { event.preventDefault(); const id = event.dataTransfer?.getData('text/plain'); const dragged = tasks.find((task) => task.id === id); if (dragged) void moveTask(dragged, stage.id); }}><div class="column-heading"><span class="column-dot {stage.id}"></span><h2>{stage.label}</h2><span class="count">{visibleTasks.filter((t) => t.status === stage.id).length}</span></div>
                                    {#each visibleTasks.filter((t) => t.status === stage.id) as task (task.id)}
                                        <button draggable="true" on:dragstart={(event) => event.dataTransfer?.setData('text/plain', task.id)} class:task-selected={selectedTask?.id === task.id} class="task-card panel" on:click={() => void openTask(task)}>
                                            <div class="task-meta"><span class="priority {task.priority}">{task.priority}</span><span class="task-id">{task.id.slice(0, 6)}</span></div>
                                            <h3>{task.title}</h3><p>{task.description || 'Sin descripción'}</p>
                                            <div class="task-footer"><span>{task.assignee_agent_id ? '⌘ Agente' : '◉ Piloto'}</span>{#if task.due_at}<span>{formatDate(task.due_at)}</span>{/if}</div>
                                        </button>
                                    {/each}
                                    {#if visibleTasks.filter((t) => t.status === stage.id).length === 0}<p class="column-empty">Sin tareas</p>{/if}
                                </div>
                            {/each}
                        </div>
                        {#if selectedTask}
                            <aside class="task-detail panel">
                                <div class="detail-top"><span class="eyebrow">DETALLE DE TAREA</span><button class="icon-button" on:click={() => selectedTask = null}>×</button></div>
                                <input class="detail-title" bind:value={selectedTask.title} />
                                <label>Estado<select bind:value={taskStatus}>{#each stages as stage}<option value={stage.id}>{stage.label}</option>{/each}</select></label>
                                <label>Prioridad<select bind:value={selectedTask.priority}><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
                                <label>Agente asignado<select bind:value={selectedTask.assignee_agent_id}><option value={null}>Sin asignar</option>{#each agents.filter((agent) => agent.status === 'active') as agent (agent.id)}<option value={agent.id}>{agent.name}{agent.id === 'meido-primary-agent' ? ' · principal' : ''}</option>{/each}</select></label>
                                <label>Descripción<textarea rows="4" bind:value={selectedTask.description}></textarea></label>
                                <button class="primary full" on:click={saveTask} disabled={busy}>Guardar tarea</button>
                                <div class="comments-section"><div class="section-title"><h2>Conversación</h2><span>{comments.length}</span></div>
                                    <div class="comment-compose"><select bind:value={commentType}>{#each types as type}<option value={type}>{type}</option>{/each}</select><textarea bind:value={commentText} rows="3" placeholder="Deja una instrucción, decisión o actualización…"></textarea><button class="secondary full" on:click={addComment} disabled={busy || !commentText.trim()}>Añadir comentario</button></div>
                                    <div class="comment-list">{#each comments as comment (comment.id)}<article class="comment"><div class="comment-head"><strong>{comment.actor}</strong><span class="comment-type">{comment.comment_type}</span><time>{formatDate(comment.created_at)}</time></div><p>{comment.content}</p></article>{/each}{#if comments.length === 0}<p class="column-empty">Aún no hay conversación.</p>{/if}</div>
                                </div>
                            </aside>
                        {:else if taskTitle || taskDescription || view === 'tasks'}
                            <aside class="task-detail panel new-task-panel"><div class="detail-top"><span class="eyebrow">NUEVA TAREA</span><button class="icon-button" on:click={() => { taskTitle = ''; taskDescription = ''; }}>×</button></div><input class="detail-title" bind:value={taskTitle} placeholder="¿Qué hay que hacer?" /><label>Descripción<textarea rows="5" bind:value={taskDescription} placeholder="Contexto para el agente y el piloto"></textarea></label><div class="form-row"><label>Prioridad<select bind:value={taskPriority}><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label><label>Asignar<select bind:value={taskAssignee}><option value="">Sin asignar</option>{#each agents.filter((agent) => agent.status === 'active') as agent (agent.id)}<option value={agent.id}>{agent.name}</option>{/each}</select></label></div><button class="primary full" on:click={newTask} disabled={busy || !taskTitle.trim() || !selectedProjectId}>Crear tarea</button><p class="hint">Al crear tareas se registra un evento inmutable.</p></aside>
                        {/if}
                    </div>
                {/if}
                {#if !activeProject}<div class="empty-state panel"><span>▦</span><h2>Selecciona un proyecto</h2><p>Crea un proyecto para comenzar a organizar tareas.</p><button class="primary" on:click={() => view = 'projects'}>Ir a proyectos</button></div>{/if}
            </section>
        {:else if view === 'memory'}
            <section class="page-content">
                <div class="page-heading"><div><p class="eyebrow">CONTEXTO PERSISTENTE</p><h1>Memoria</h1><p class="subtitle">Notas que tus agentes pueden recuperar entre sesiones.</p></div><button class="primary" on:click={newNote}>＋ Nueva nota</button></div>
                <div class="memory-layout"><aside class="memory-list panel"><input class="search" bind:value={search} placeholder="Buscar memoria…" />{#each notes.filter((note) => `${note.title ?? ''} ${note.content}`.toLowerCase().includes(search.trim().toLowerCase())) as note (note.id)}<button class:memory-selected={selectedNote?.id === note.id} on:click={() => void openNote(note)}><strong>{note.status === 'attended' ? '✓ ' : ''}{note.title || 'Sin título'}</strong><small>{note.content.slice(0, 96)}</small><span>{note.status === 'attended' ? 'Atendida' : 'Activa'} · {formatDate(note.updated_at)}</span></button>{/each}{#if notes.length === 0}<p class="column-empty">Todavía no hay notas.</p>{/if}</aside>
                    <div class="memory-editor panel"><input class="memory-title" bind:value={noteTitle} placeholder="Título de la memoria" /><textarea class="memory-content" bind:value={noteContent} placeholder="Decisiones, convenciones, contexto del proyecto o aprendizajes reutilizables…"></textarea>
                        {#if selectedNote}<div class="image-area"><div class="image-area-head"><div><h2>Imágenes de referencia</h2><p>Adjuntos locales para contexto visual y documentación.</p></div><label class="attach-button">＋ Imagen<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" on:change={addImage} disabled={busy} /></label></div>{#if imageNotice}<small class="image-notice">{imageNotice}</small>{/if}<div class="image-grid">{#each noteImages as image (image.id)}<figure><img src={imageUrls[image.id]} alt={image.filename} /><figcaption><span>{image.filename}</span><button title="Borrar imagen" on:click={() => void removeImage(image.id)} disabled={busy}>×</button></figcaption></figure>{/each}{#if noteImages.length === 0}<p class="image-empty">Adjunta capturas, diagramas o fotografías a esta memoria.</p>{/if}</div></div>{/if}
                        <div class="memory-foot"><span>{selectedNote?.status === 'attended' ? 'Nota atendida · conservada' : status?.configured ? status.pending ? `${status.pending} cambios pendientes` : 'Sincronizada con la nube' : 'Guardado local · nube sin configurar'}</span><div>{#if selectedNote?.status !== 'attended'}<button class="secondary" on:click={attendNote} disabled={busy || !selectedNote}>Marcar atendida</button>{/if}<button class="primary" on:click={saveNote} disabled={busy || !noteContent.trim()}>Guardar memoria</button></div></div></div>
                </div>
            </section>
        {:else if view === 'images'}
            <section class="page-content">
                <div class="page-heading"><div><p class="eyebrow">BIBLIOTECA DEL PROYECTO</p><h1>Imágenes</h1><p class="subtitle">Sube y consulta referencias visuales, capturas y archivos del proyecto.</p></div>
                    <div class="image-library-actions"><select aria-label="Proyecto de imágenes" value={selectedProjectId} on:change={selectImageProject}><option value="">Selecciona un proyecto</option>{#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}</select>
                        <label class="primary upload-button" class:disabled={!selectedProjectId || busy}>＋ Subir imágenes<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple on:change={addProjectImages} disabled={!selectedProjectId || busy} /></label></div>
                </div>
                {#if projectImageNotice}<div class="image-library-notice">{projectImageNotice}</div>{/if}
                {#if projects.length === 0}<div class="empty-state panel"><span>▧</span><h2>Crea un proyecto primero</h2><p>La galería guarda sus imágenes dentro de un proyecto.</p><button class="primary" on:click={() => view = 'projects'}>Ir a proyectos</button></div>
                {:else if projectImages.length === 0}<div class="empty-state panel"><span>▧</span><h2>La galería está vacía</h2><p>Sube imágenes para tener a mano las referencias visuales de {activeProject?.name ?? 'este proyecto'}.</p></div>
                {:else}<div class="gallery-grid">{#each projectImages as image (image.id)}<figure class="gallery-card panel"><img src={projectImageUrls[image.id]} alt={image.filename} loading="lazy" /><figcaption><div><strong title={image.filename}>{image.filename}</strong><small>{(image.size / 1024 / 1024).toFixed(2)} MB · {formatDate(image.created_at)}</small></div><button class="danger-ghost" title="Borrar imagen" aria-label={`Borrar ${image.filename}`} on:click={() => void removeProjectImage(image)} disabled={busy}>×</button></figcaption></figure>{/each}</div>{/if}
                <p class="gallery-storage-hint">Las imágenes se guardan en este equipo. Límite: 10 MB por archivo, 200 archivos y 50 MB por proyecto.</p>
            </section>
        {:else if view === 'graph'}
            <section class="page-content"><div class="page-heading"><div><p class="eyebrow">MAPA DEL WORKSPACE</p><h1>Grafo de proyectos</h1><p class="subtitle">Explora tareas, módulos, funciones, datos e integraciones. Arrastra para orbitar.</p></div><button class="secondary" on:click={() => void openGraph()}>Actualizar mapa</button></div>
                <div class="graph-controls panel"><select aria-label="Proyecto del mapa" bind:value={graphProjectFilter}><option value="">Todos los proyectos</option>{#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}</select><select aria-label="Filtrar elementos del mapa" bind:value={graphFilter}><option value="all">Todos los elementos</option><option value="projects">Solo proyectos</option><option value="tasks">Proyectos y tareas</option><option value="knowledge">Proyectos y conocimiento</option></select><input bind:value={graphSearch} placeholder="Buscar nodo…" aria-label="Buscar en el mapa" /><span>{visibleGraphNodes.length} / {graphNodes.length}</span></div>
                {#if selectedKnowledge}<article class="knowledge-detail panel"><div><span class="knowledge-kind">{selectedKnowledge.kind}</span><h2>{selectedKnowledge.title}</h2><p>{selectedKnowledge.summary}</p><small>{selectedKnowledgeProject} · {selectedKnowledge.source}</small><div class="knowledge-tags">{#each selectedKnowledge.tags as tag}<span>{tag}</span>{/each}</div></div><button class="secondary" on:click={() => selectedKnowledge = null}>Cerrar</button></article>{/if}
                {#if visibleGraphNodes.length}<div class="graph-panel panel"><ThreeDGraph nodes={visibleGraphNodes} links={visibleGraphLinks} onSelect={(node) => void openGraphNode(node)} /></div>{:else}<div class="empty-state panel"><span>⌘</span><h2>Sin elementos para relacionar</h2><p>Cambia el filtro o crea proyectos y tareas para verlos aquí.</p></div>{/if}
            </section>
        {:else if view === 'activity'}
            <section class="page-content"><div class="page-heading"><div><p class="eyebrow">HISTORIAL INMUTABLE</p><h1>Actividad</h1><p class="subtitle">Registro cronológico de cambios, decisiones y conversación.</p></div><span class="sync-pill">{events.length} recientes</span></div><div class="activity-list panel">{#each events as event (event.id)}<article class="activity-item"><span class="event-mark">{event.actor_type === 'agent' ? '⌘' : 'P'}</span><div><strong>{event.event_type.replace('.', ' ')}</strong><p>{event.entity_type} · {event.entity_id.slice(0, 8)} · {event.actor}</p><small>{event.payload}</small></div><time>{formatDate(event.created_at)}</time></article>{/each}{#if events.length === 0}<div class="empty-state"><h2>Aún no hay actividad</h2><p>Los eventos aparecerán aquí al crear proyectos, tareas y comentarios.</p></div>{/if}</div></section>
        {:else}
            <section class="page-content"><div class="page-heading"><div><p class="eyebrow">IDENTIDADES DE AGENTE</p><h1>Agentes</h1><p class="subtitle">Meido es la coordinadora principal; asigna tareas y administra las demás identidades aquí.</p></div><span class="heading-icon">⌘</span></div>
                <div class="agent-layout"><div class="agent-create panel"><h2>{editingAgentId ? 'Editar agente' : 'Registrar agente'}</h2><p>Guarda su identidad, modelo y cliente para asignarle trabajo y atribuir eventos.</p><label>Nombre<input bind:value={agentName} placeholder="ej. codex-backend" maxlength="120" /></label><label>Modelo<input bind:value={agentModel} placeholder="ej. gpt-6.1-codex" /></label><div class="form-row"><label>Proveedor<input bind:value={agentProvider} placeholder="OpenAI" /></label><label>Cliente<select bind:value={agentClient}><option value="primary">Coordinadora</option><option value="codex">Codex</option><option value="claude_code">Claude Code</option><option value="cursor">Cursor</option><option value="other">Otro</option></select></label></div><button class="primary full" on:click={saveAgent} disabled={busy || !agentName.trim()}>{editingAgentId ? 'Guardar cambios' : 'Registrar en este equipo'}</button>{#if editingAgentId}<button class="secondary full" on:click={() => { editingAgentId = ''; agentName = ''; agentModel = ''; agentProvider = ''; agentClient = 'codex'; }}>Cancelar edición</button>{/if}<p class="hint">La identidad local no genera por sí sola una credencial para acceder remotamente.</p></div>
                    <div class="agent-list">{#each agents as agent (agent.id)}<article class="agent-card panel"><span class="agent-icon">{agent.id === 'meido-primary-agent' ? '✦' : '⌘'}</span><div><h3>{agent.name}{agent.id === 'meido-primary-agent' ? ' · principal' : ''}</h3><p>{agent.model || 'Modelo sin definir'} · {agent.provider || 'Proveedor sin definir'}</p><small>{agent.client_type} · registrado {formatDate(agent.created_at)}</small></div><span class="agent-status" class:agent-disabled={agent.status !== 'active'}>{agent.status}</span><div class="agent-actions"><button class="secondary" on:click={() => editAgent(agent)}>Editar</button>{#if agent.id !== 'meido-primary-agent' && agent.status === 'active'}<button class="danger-ghost" on:click={() => void removeAgent(agent)} disabled={busy}>Desactivar</button>{/if}</div></article>{/each}{#if agents.length === 0}<div class="empty-state panel"><span>⌘</span><h2>Agentes con identidad propia</h2><p>Registra el primero para empezar a organizar quién ejecuta cada tarea.</p></div>{/if}</div></div>
            </section>
        {/if}
    </main>
</div>
{#if showProfile}<div class="profile-overlay" role="presentation"><dialog open class="profile-dialog" aria-label="Perfil de usuario"><header><div><p class="eyebrow">CUENTA CLERK</p><h2>Mi perfil</h2></div><button class="secondary" on:click={closeProfile}>Cerrar</button></header><div class="profile-mount" bind:this={profileNode}></div></dialog></div>{/if}
{/if}

<style>
    :global(*) { box-sizing: border-box; }
    :global(body) { margin: 0; background: #0e1117; color: #e6edf3; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 14px; }
    :global(button), :global(input), :global(textarea), :global(select) { font: inherit; }
    :global(button) { cursor: pointer; }
    .desktop-auth-screen { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(ellipse at 50% 0,#1b2c37 0,transparent 55%),#0e1117; }
    .desktop-auth-card { width: min(460px,100%); padding: 30px; border: 1px solid #2b3743; border-radius: 14px; background: #141b23; box-shadow: 0 20px 80px #0005; }
    .desktop-auth-card h1 { margin: 6px 0 8px; font-size: 25px; color: #f1f5f9; }.desktop-auth-card p { color: #b5c1cc; font-size: 12px; line-height: 1.6; margin: 0; }
    .desktop-clerk-widget { margin-top: 20px; }.desktop-auth-error { display:block; color:#ffb4ad; margin-top:12px; }.user-email { color:#91a0ae; font-size:10px; }
    .profile-overlay { position:fixed; inset:0; z-index:50; display:grid; place-items:center; padding:24px; background:#05080dcc; }.profile-dialog { width:min(920px,100%); max-height:min(90vh,900px); overflow:auto; padding:0; color:#e6edf3; border:1px solid #34414e; border-radius:14px; background:#111820; box-shadow:0 24px 90px #0009; }.profile-dialog>header { position:sticky; top:0; z-index:1; display:flex; justify-content:space-between; align-items:center; padding:16px 20px; background:#111820; border-bottom:1px solid #293541; }.profile-dialog h2 { margin:0; font-size:17px; }.profile-dialog .eyebrow { margin:0 0 4px; }.profile-mount { min-height:520px; padding:14px; }
    .app-shell { display: grid; grid-template-columns: 244px minmax(0, 1fr); height: 100vh; height: 100dvh; overflow: hidden; }
    .sidebar { background: #11161e; border-right: 1px solid #242b36; display: flex; flex-direction: column; padding: 19px 13px 12px; height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; }
    .brand { display: flex; align-items: center; gap: 10px; color: #f0f4f8; text-decoration: none; font-size: 17px; font-weight: 700; padding: 0 8px 28px; letter-spacing: -0.4px; }
    .brand small { display: block; color: #768394; font-size: 9px; letter-spacing: 1.5px; margin-top: 2px; }
    .brand-mark { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; color: #071018; background: linear-gradient(135deg,#8ce8d1,#74a9ff); font-weight: 800; }
    .nav-label { color: #687587; font-size: 10px; font-weight: 700; letter-spacing: 1px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; }
    .nav-label button { border: 0; color: #97a4b4; background: transparent; font-size: 17px; padding: 0 4px; }
    nav { display: grid; gap: 3px; }
    nav button, .project-link { width: 100%; border: 0; border-radius: 7px; background: transparent; color: #aab5c3; text-align: left; padding: 9px 10px; display: flex; align-items: center; gap: 11px; }
    nav button span { width: 17px; color: #8492a3; text-align: center; font-size: 15px; }
    nav button:hover, .project-link:hover { background: #1a222d; color: #eef3f8; }
    nav button.active { color: #a6f2df; background: #182a2a; }
    nav button.active span { color: #86dfc9; }
    nav button:disabled { opacity: .4; cursor: default; }
    .sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #35404d transparent; }
    .sidebar-projects { margin-top: 25px; }
    .project-link { font-size: 12px; padding: 8px 10px; }
    .project-active { color: #e6edf3; background: #1b2430; }
    .project-dot, .project-card-foot i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: #75d6bb; }
    .side-empty { color: #687587; font-size: 11px; padding-left: 10px; }
    .sidebar-bottom { flex: none; border-top: 1px solid #242b36; margin-top: auto; padding: 14px 6px 0; display: flex; align-items: center; gap: 9px; }
    .pilot-avatar,.avatar-button { width: 29px; height: 29px; border-radius: 50%; display: grid; place-items: center; color: #b8c8ff; background: #303b52; font-weight: 700; }
    .pilot-text { display: grid; gap: 2px; font-size: 11px; }.pilot-text small { color: #788697; font-size: 10px; }
    .cloud-indicator { color: #596675; font-size: 12px; margin-left: auto; }.cloud-indicator.cloud-on { color: #75d6bb; }
    .main-area { min-width: 0; min-height: 0; height: 100vh; height: 100dvh; overflow: hidden; display: flex; flex-direction: column; }
    .topbar { height: 60px; flex: none; padding: 0 30px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #242b36; background: #11161e; }
    .breadcrumbs { display: flex; gap: 10px; align-items: center; color: #758294; font-size: 12px; }.breadcrumbs strong { color: #dbe3ec; font-weight: 600; }.crumb-sep { color: #3e4957; }
    .top-actions { display: flex; align-items: center; gap: 15px; }.sync-pill { color: #8e9baa; background: #171e27; border: 1px solid #2a3441; padding: 6px 10px; border-radius: 20px; font-size: 11px; }.avatar-button { border: 0; width:auto; height:auto; border-radius:6px; padding:7px 10px; color:#b8c8ff; background:#303b52; }
    .page-content { width: 100%; max-width: 1500px; min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #35404d transparent; margin: 0 auto; padding: 34px 34px 60px; }
    .page-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 26px; }.page-heading h1 { font-size: 27px; letter-spacing: -.8px; margin: 2px 0 7px; }.eyebrow { color: #7890a3; font-size: 10px; letter-spacing: 1.3px; font-weight: 700; margin: 0 0 7px; }.subtitle { color: #8b98a7; margin: 0; font-size: 13px; }.heading-icon { width: 48px; height: 48px; border: 1px solid #2a3846; background: #15212a; color: #8ce8d1; display: grid; place-items: center; border-radius: 13px; font-size: 21px; }
    .panel { background: #141a22; border: 1px solid #27313d; border-radius: 11px; }
    .project-create { display: flex; gap: 30px; align-items: center; justify-content: space-between; padding: 20px 22px; margin-bottom: 29px; }.project-create h2,.agent-create h2 { font-size: 14px; margin: 0 0 5px; }.project-create p,.agent-create p { margin: 0; color: #8996a5; font-size: 12px; }
    .project-form { display: grid; grid-template-columns: minmax(150px,1fr) minmax(180px,1.4fr) auto; gap: 8px; width: min(740px,70%); }
    .project-relations { display: grid; gap: 13px; padding: 18px 20px; margin: 0 0 28px; }.project-relations h2 { font-size: 13px; margin: 0 0 4px; }.project-relations p { margin: 0; color: #8996a5; font-size: 11px; }.relation-form { display: grid; grid-template-columns: minmax(110px,1fr) minmax(125px,.9fr) minmax(110px,1fr) minmax(160px,1.2fr) auto; gap: 8px; }.relation-form select,.relation-form input { min-width: 0; font-size: 11px; }.relation-list { display: flex; gap: 8px; flex-wrap: wrap; }.relation-list > span { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 8px; max-width: 380px; padding: 8px 10px; border-radius: 7px; background: #101820; border: 1px solid #293742; color: #cbd6e1; font-size: 10px; }.relation-list strong { font-weight: 600; }.relation-list small { color: #8c9ba9; }.relation-list .relation-explanation { grid-column: 1; line-height: 1.45; }.relation-list button { grid-column: 2; grid-row: 1 / span 2; border: 0; background: transparent; color: #fa9e98; padding: 0 2px; align-self: center; }
    input,textarea,select { color: #e1e7ee; color-scheme: dark; background-color: #0f141b; border: 1px solid #394655; border-radius: 7px; padding: 9px 32px 9px 11px; outline: none; width: 100%; }.project-form input { font-size: 12px; }.project-form input:focus,textarea:focus,input:focus,select:focus { border-color: #5b9d8e; box-shadow: 0 0 0 2px #24524544; } select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2393a4b5' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; } option { color: #e1e7ee; background: #141b24; }
    .primary,.secondary { border: 1px solid #5aa991; color: #061813; background: #8ce8d1; border-radius: 7px; padding: 9px 13px; font-size: 12px; font-weight: 700; white-space: nowrap; }.primary:hover { background: #a4f1df; }.primary:disabled,.secondary:disabled { opacity: .5; cursor: default; }.primary span { margin-left: 8px; }.secondary { background: #1b2b2a; border-color: #34544d; color: #9ce9d6; }
    .section-title { display: flex; align-items: center; gap: 10px; margin: 24px 0 13px; }.section-title h2 { margin: 0; font-size: 14px; }.section-title span { color: #748294; font-size: 11px; }
    .project-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(240px,1fr)); gap: 13px; }.project-card { color: inherit; text-align: left; padding: 17px; transition: border-color .15s,transform .15s; }.project-card:hover { border-color: #4b766c; transform: translateY(-2px); }.project-card-top { display: flex; justify-content: space-between; }.project-icon { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: #92e5d1; background: #1a302d; }.card-arrow { color: #768596; }.project-card h3 { margin: 17px 0 6px; font-size: 14px; }.project-card p { color: #8a97a6; font-size: 12px; line-height: 1.5; min-height: 36px; margin: 0; }.project-card-foot { border-top: 1px solid #27313d; margin-top: 15px; padding-top: 11px; display: flex; justify-content: space-between; font-size: 10px; color: #788697; }.project-card-foot span:first-child { display: flex; align-items: center; gap: 6px; }
    .empty-state { text-align: center; padding: 45px 20px; color: #8592a1; }.empty-state > span { display: block; color: #6ab8a4; font-size: 25px; margin-bottom: 13px; }.empty-state h2 { color: #d5dee8; font-size: 16px; margin: 0 0 8px; }.empty-state p { font-size: 12px; margin: 0 0 15px; }
    .heading-actions { display: flex; gap: 9px; align-items: center; }.search { width: 220px; padding: 8px 11px; font-size: 12px; }
    .task-heading { align-items: end; }.task-workspace { display: flex; flex-direction: column; gap: 18px; align-items: stretch; }.board { display: grid; grid-template-columns: repeat(6,minmax(145px,1fr)); gap: 10px; overflow-x: auto; align-items: start; }.column { min-width: 145px; min-height: 110px; border-radius: 9px; padding: 8px; background: #111720; border: 1px solid #202a35; }.column:has(.task-card:hover) { border-color: #3c665c; }.column-heading { display: flex; align-items: center; gap: 7px; padding: 3px 3px 10px; }.column-heading h2 { color: #b9c3cf; font-size: 11px; margin: 0; font-weight: 650; }.column-dot { width: 7px; height: 7px; border-radius: 50%; background: #8492a3; }.column-dot.in_progress { background: #78a9fc; }.column-dot.blocked { background: #f3aa6c; }.column-dot.done { background: #75d6a4; }.column-dot.backlog { background: #a28af1; }.count { color: #718093; font-size: 10px; background: #1a222c; border-radius: 10px; padding: 2px 6px; }.task-card { display: block; width: 100%; color: inherit; text-align: left; padding: 12px; margin-bottom: 8px; cursor: grab; }.task-card:active { cursor: grabbing; }.task-card:hover,.task-card.task-selected { border-color: #529585; }.task-meta,.task-footer { display: flex; justify-content: space-between; align-items: center; }.priority { text-transform: uppercase; letter-spacing: .5px; font-size: 8px; color: #94a1b0; background: #222b36; border-radius: 4px; padding: 3px 5px; }.priority.high,.priority.urgent { color: #ffad9b; background: #3a2628; }.priority.low { color: #84ccb7; background: #1c302d; }.task-id { color: #657384; font-size: 9px; }.task-card h3 { font-size: 12px; line-height: 1.45; margin: 10px 0 6px; }.task-card p { color: #8693a1; font-size: 10px; line-height: 1.5; margin: 0 0 12px; }.task-footer { color: #778597; font-size: 9px; }.column-empty { color: #5e6b7a; text-align: center; padding: 18px 5px; font-size: 11px; }
    .task-detail { width: 100%; padding: 16px; max-height: none; overflow: visible; }.detail-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }.icon-button { border: 0; background: transparent; color: #8290a0; font-size: 20px; }.detail-title { font-size: 16px; font-weight: 650; background: transparent; padding: 8px 0; border: 0; border-bottom: 1px solid #303b48; border-radius: 0; margin-bottom: 13px; }.task-detail label,.agent-create label { display: grid; gap: 6px; color: #9ba7b5; font-size: 10px; margin: 10px 0; }.task-detail select,.task-detail textarea,.agent-create input,.agent-create select { font-size: 11px; }.full { width: 100%; }.comments-section { border-top: 1px solid #28323e; margin-top: 18px; padding-top: 6px; }.comment-compose { display: grid; gap: 7px; }.comment-list { margin-top: 12px; }.comment { padding: 10px 0; border-top: 1px solid #242d38; }.comment-head { display: flex; align-items: center; gap: 7px; }.comment-head strong { font-size: 10px; }.comment-type { color: #89d9c2; background: #1b302d; font-size: 8px; border-radius: 4px; padding: 3px 5px; }.comment-head time { color: #728090; font-size: 8px; margin-left: auto; }.comment p { color: #aab5c2; font-size: 10px; line-height: 1.5; white-space: pre-wrap; }.hint { color: #758393; font-size: 10px; line-height: 1.5; }
    .memory-layout { display: grid; grid-template-columns: 280px minmax(0,1fr); gap: 13px; min-height: 500px; }.memory-list { padding: 10px; }.memory-list button { display: grid; text-align: left; gap: 5px; width: 100%; border: 0; border-radius: 7px; background: transparent; padding: 11px 9px; color: #dbe3ec; }.memory-list button:hover,.memory-list button.memory-selected { background: #1b282d; }.memory-list strong { font-size: 11px; }.memory-list small { color: #8491a0; font-size: 10px; line-height: 1.4; }.memory-list span { color: #657486; font-size: 9px; }.memory-editor { padding: 16px; display: flex; flex-direction: column; }.memory-title { font-size: 19px; font-weight: 650; background: transparent; border: 0; padding: 8px 0 14px; }.memory-content { flex: 1; min-height: 340px; resize: vertical; line-height: 1.7; background: transparent; border: 0; padding: 8px 0; }.memory-foot { display: flex; justify-content: space-between; gap: 15px; align-items: center; border-top: 1px solid #29333e; padding-top: 12px; color: #798798; font-size: 10px; }.memory-foot div { display: flex; gap: 9px; }.danger-ghost { color: #f59f9b; border: 1px solid #613c3c; background: transparent; border-radius: 7px; padding: 8px 11px; font-size: 11px; }
    .image-area { border-top: 1px solid #29333e; padding: 14px 0; }.image-area-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }.image-area h2 { font-size: 12px; margin: 0 0 4px; }.image-area-head p,.image-notice { color: #7f8d9d; font-size: 10px; margin: 0; }.attach-button { background: #1c302d; color: #9be5d1; padding: 7px 10px; border-radius: 6px; font-size: 10px; cursor: pointer; }.attach-button input { display: none; }.image-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(120px,1fr)); gap: 9px; margin-top: 12px; }.image-grid figure { overflow: hidden; border: 1px solid #2b3541; border-radius: 7px; margin: 0; background: #10151c; }.image-grid img { display: block; width: 100%; height: 100px; object-fit: cover; }.image-grid figcaption { display: flex; gap: 5px; justify-content: space-between; align-items: center; padding: 5px 7px; font-size: 9px; color: #91a0b0; }.image-grid figcaption span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.image-grid figcaption button { color: #f1a29e; background: transparent; border: 0; }.image-empty { color: #687687; font-size: 10px; }
    .image-library-actions { display: flex; align-items: center; gap: 9px; }.image-library-actions select { min-width: 190px; font-size: 12px; }.upload-button { position: relative; overflow: hidden; }.upload-button input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }.upload-button.disabled { opacity: .5; cursor: default; }.upload-button.disabled input { cursor: default; }.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(210px,1fr)); gap: 14px; }.gallery-card { overflow: hidden; margin: 0; }.gallery-card > img { display: block; width: 100%; height: 180px; object-fit: cover; background: #0e1117; }.gallery-card figcaption { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 11px; }.gallery-card figcaption div { display: grid; gap: 4px; min-width: 0; }.gallery-card figcaption strong { color: #dbe3ec; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.gallery-card figcaption small,.gallery-storage-hint { color: #788697; font-size: 9px; }.gallery-card .danger-ghost { padding: 4px 8px; flex: none; }.gallery-storage-hint { margin-top: 18px; }.image-library-notice { color: #ffb4ad; background: #321f22; border: 1px solid #613338; border-radius: 7px; padding: 9px 12px; margin-bottom: 14px; font-size: 11px; }
    .activity-list { padding: 3px 18px; }.activity-item { display: flex; gap: 12px; padding: 16px 0; border-bottom: 1px solid #28313b; align-items: flex-start; }.activity-item:last-child { border-bottom: 0; }.event-mark { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: #96e1cd; background: #1c302d; font-size: 11px; }.activity-item div { min-width: 0; flex: 1; }.activity-item strong { font-size: 11px; text-transform: capitalize; }.activity-item p { color: #8895a4; font-size: 10px; margin: 5px 0; }.activity-item small { color: #687688; font-size: 9px; display: block; overflow-wrap: anywhere; }.activity-item time { color: #748192; font-size: 9px; white-space: nowrap; }
    .agent-layout { display: grid; grid-template-columns: 330px minmax(0,1fr); gap: 14px; align-items: start; }.agent-create { padding: 17px; }.agent-create h2 { font-size: 14px; }.agent-create > p { margin-bottom: 15px; line-height: 1.5; }.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.agent-list { display: grid; gap: 9px; }.agent-card { display: flex; align-items: center; gap: 12px; padding: 14px; }.agent-icon { width: 32px; height: 32px; display: grid; place-items: center; color: #b49aff; background: #292339; border-radius: 9px; }.agent-card > div:not(.agent-actions) { flex: 1; }.agent-card h3 { margin: 0 0 4px; font-size: 12px; }.agent-card p,.agent-card small { color: #8794a3; font-size: 10px; margin: 0 0 3px; }.agent-status { color: #82d7b9; font-size: 9px; background: #1b302b; padding: 4px 7px; border-radius: 10px; }.agent-status.agent-disabled { color: #f3b184; background: #38291f; }.agent-actions { display: flex; gap: 6px; }.agent-actions button { padding: 6px 8px; font-size: 10px; }
    .graph-panel { padding: 12px; overflow: hidden; min-height: 68vh; background: radial-gradient(circle at center,#18222c 0,#11161e 70%); }
    .graph-controls { display: flex; align-items: center; gap: 9px; padding: 10px; margin-bottom: 10px; }.graph-controls select { max-width: 290px; }.graph-controls input { flex: 1; min-width: 120px; }.graph-controls span { color: #8191a0; font-size: 10px; white-space: nowrap; }
    .knowledge-detail { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px; margin-bottom: 10px; }.knowledge-detail h2 { margin: 6px 0; font-size: 15px; }.knowledge-detail p { color: #abb8c5; margin: 0 0 9px; font-size: 12px; line-height: 1.5; }.knowledge-detail small { color: #8192a3; font-size: 10px; overflow-wrap: anywhere; }.knowledge-kind { color: #d0a8f4; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; }.knowledge-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 10px; }.knowledge-tags span { color: #9aabb9; padding: 3px 6px; background: #202a35; border-radius: 5px; font-size: 9px; }
    .toast { margin: 12px 30px 0; padding: 9px 12px; border-radius: 7px; display: flex; justify-content: space-between; font-size: 11px; }.toast button { border: 0; background: transparent; color: inherit; }.error-toast { color: #ffb4ad; background: #321f22; border: 1px solid #613338; }.notice-toast { color: #a3ead8; background: #192b29; border: 1px solid #31544b; }
    @media (max-width: 1050px) { .task-workspace { grid-template-columns: 1fr; }.board { grid-template-columns: repeat(5,190px); }.task-detail { position: static; max-height: none; }.project-create { align-items: flex-start; flex-direction: column; }.project-form { width: 100%; } }
    @media (max-width: 1050px) { .relation-form { grid-template-columns: 1fr 1fr; }.relation-form button { grid-column: 1 / -1; } }
    @media (max-width: 720px) { .app-shell { grid-template-columns: 60px minmax(0,1fr); }.sidebar { padding: 12px 7px; }.brand { padding: 0 7px 24px; }.brand > span:last-child,.nav-label,.sidebar-projects,.sidebar-bottom .pilot-text,.cloud-indicator { display: none; } nav button { justify-content: center; padding: 11px 4px; font-size: 0; } nav button span { font-size: 16px; }.topbar { padding: 0 14px; }.page-content { padding: 25px 14px; }.page-heading { align-items: flex-start; flex-direction: column; }.heading-actions,.image-library-actions { width: 100%; }.heading-actions .search { flex: 1; min-width: 0; }.project-form { grid-template-columns: 1fr; }.relation-form { grid-template-columns: 1fr; }.relation-form button { grid-column: auto; }.memory-layout,.agent-layout { grid-template-columns: 1fr; }.memory-list { max-height: 230px; overflow: auto; }.memory-foot { align-items: flex-start; flex-direction: column; }.memory-foot div { width: 100%; }.memory-foot button { flex: 1; }.activity-item { flex-wrap: wrap; }.activity-item time { margin-left: 40px; }.image-library-actions select { min-width: 0; flex: 1; }.gallery-grid { grid-template-columns: repeat(auto-fill,minmax(150px,1fr)); } }
</style>
