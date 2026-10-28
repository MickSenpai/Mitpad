import { invoke } from '@tauri-apps/api/core';

// Puente entre la interfaz y los comandos de Rust (src-tauri/src/db/queries.rs).
// Las fechas son milisegundos desde 1970, el mismo formato que usa Convex.

// 1. Definimos la interfaz reflejando exactamente el modelo Note de Rust
export interface Note {
    id: string;
    user_id: string;
    title: string | null; // Refleja el Option<String> de Rust
    content: string;
    status: 'open' | 'attended';
    created_at: number; // ms desde 1970
    updated_at: number; // ms desde 1970
    synced_at: number | null; // null = todavía no se ha subido a la nube
}

// 2. Estado de la cola de sincronización
export interface SyncStatus {
    pending: number; // operaciones esperando
    failed: number; // operaciones apartadas tras fallar
    last_error: string | null;
    last_sync_at: number | null;
    configured: boolean; // ¿hay URL y token para hablar con la nube?
}

export interface Project {
    id: string; name: string; description: string; status: string;
    created_at: number; updated_at: number;
}
export interface ProjectLink {
    id: string; source_project_id: string; target_project_id: string;
    relation_type: 'related_to' | 'parent_of' | 'depends_on'; description: string; created_at: number;
}
export interface Task {
    id: string; project_id: string; title: string; description: string;
    status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done';
    priority: 'low' | 'medium' | 'high' | 'urgent';
    assignee_agent_id: string | null; due_at: number | null;
    created_at: number; updated_at: number;
}
export interface TaskComment {
    id: string; task_id: string; actor_type: string; actor: string;
    comment_type: 'message' | 'instruction' | 'question' | 'answer' | 'decision' | 'update';
    content: string; created_at: number;
}
export interface ActivityEvent {
    id: string; project_id: string | null; actor_type: string; actor: string;
    event_type: string; entity_type: string; entity_id: string; payload: string; created_at: number;
}
export interface Agent {
    id: string; name: string; model: string | null; provider: string | null;
    client_type: string | null; status: string; created_at: number; last_seen_at: number | null;
}
export interface NoteImage {
    id: string; note_id: string; filename: string; content_type: string;
    size: number; cloud_image_id: string | null; created_at: number;
}
export interface ProjectImage {
    id: string; project_id: string; filename: string; content_type: string;
    size: number; created_at: number;
}
export interface ProjectKnowledge {
    id: string; project_id: string;
    kind: 'module' | 'function' | 'data' | 'capability' | 'integration' | 'decision';
    title: string; summary: string; source: string; tags: string[]; updated_at: number;
}

// 3. Función asíncrona para llamar a Rust (Crear)
export async function createLocalNote(title: string, content: string, userId: string): Promise<Note> {
    const cleanTitle = title.trim() === "" ? null : title.trim();

    try {
        const newNote: Note = await invoke('create_note', {
            title: cleanTitle,
            content: content,
            userId: userId
        });
        return newNote;
    } catch (error) {
        console.error("Fallo el IPC hacia Rust (Crear):", error);
        throw error;
    }
}

// 4. Función asíncrona para llamar a Rust (Actualizar)
export async function updateLocalNote(id: string, title: string, content: string): Promise<Note> {
    const cleanTitle = title.trim() === "" ? null : title.trim();

    try {
        return await invoke('update_note', {
            id: id,
            title: cleanTitle,
            content: content
        });
    } catch (error) {
        console.error("Fallo el IPC hacia Rust (Actualizar):", error);
        throw error;
    }
}

export const markNoteAttended = (id: string) => invoke<Note>('mark_note_attended', { id });

// 6. Todas las notas locales (la más reciente primero)
export async function listLocalNotes(): Promise<Note[]> {
    return await invoke('list_notes');
}

// 7. Estado de la sincronización
export async function getSyncStatus(): Promise<SyncStatus> {
    const status = await invoke<SyncStatus>('sync_status');
    return { ...status, configured: true };
}

// 8. Devuelve a la cola las operaciones que fallaron
export async function retryFailedSync(): Promise<number> {
    return await invoke('retry_failed');
}

export const createProject = (name: string, description: string) => invoke<Project>('create_project', { name, description });
export const listProjects = () => invoke<Project[]>('list_projects');
export const listProjectLinks = () => invoke<ProjectLink[]>('list_project_links');
export const createProjectLink = (sourceProjectId: string, targetProjectId: string, relationType: ProjectLink['relation_type'], description: string) =>
    invoke<ProjectLink>('create_project_link', { sourceProjectId, targetProjectId, relationType, description });
export const deleteProjectLink = (id: string, convexUrl: string, token: string) => invoke<void>('delete_project_link', { id, convexUrl, token });
export const listProjectKnowledge = (convexUrl: string, token: string) => invoke<ProjectKnowledge[]>('list_project_knowledge', { convexUrl, token });
export const createTask = (projectId: string, title: string, description: string, priority: Task['priority'], assigneeAgentId: string | null = null, dueAt: number | null = null) =>
    invoke<Task>('create_task', { projectId, title, description, priority, assigneeAgentId, dueAt });
export const listTasks = (projectId: string) => invoke<Task[]>('list_tasks', { projectId });
export const updateTask = (task: Task) => invoke<Task>('update_task', {
    id: task.id, title: task.title, description: task.description, status: task.status,
    priority: task.priority, assigneeAgentId: task.assignee_agent_id, dueAt: task.due_at
});
export const createTaskComment = (taskId: string, commentType: TaskComment['comment_type'], content: string) =>
    invoke<TaskComment>('create_task_comment', { taskId, commentType, content });
export const listTaskComments = (taskId: string) => invoke<TaskComment[]>('list_task_comments', { taskId });
export const listActivity = (projectId: string | null = null) => invoke<ActivityEvent[]>('list_activity', { projectId });
export const createLocalAgent = (name: string, model: string, provider: string, clientType: string) =>
    invoke<Agent>('create_local_agent', { name, model: model || null, provider: provider || null, clientType: clientType || null });
export const listAgents = () => invoke<Agent[]>('list_agents');
export const updateLocalAgent = (agent: Agent) => invoke<Agent>('update_local_agent', { id: agent.id, name: agent.name, model: agent.model, provider: agent.provider, clientType: agent.client_type });
export const deleteLocalAgent = (id: string) => invoke<void>('delete_local_agent', { id });
export const saveNoteImage = (noteId: string, filename: string, contentType: string, content: Uint8Array) =>
    invoke<NoteImage>('save_note_image', { noteId, filename, contentType, content: Array.from(content) });
export const listNoteImages = (noteId: string) => invoke<NoteImage[]>('list_note_images', { noteId });
export async function readNoteImage(id: string): Promise<Uint8Array> {
    const bytes: number[] = await invoke('read_note_image', { id });
    return new Uint8Array(bytes);
}
export const deleteNoteImage = (id: string) => invoke<void>('delete_note_image', { id });
export const saveProjectImage = (projectId: string, filename: string, contentType: string, content: Uint8Array) =>
    invoke<ProjectImage>('save_project_image', { projectId, filename, contentType, content: Array.from(content) });
export const listProjectImages = (projectId: string) => invoke<ProjectImage[]>('list_project_images', { projectId });
export async function readProjectImage(id: string): Promise<Uint8Array> {
    const bytes: number[] = await invoke('read_project_image', { id });
    return new Uint8Array(bytes);
}
export const deleteProjectImage = (id: string) => invoke<void>('delete_project_image', { id });
export const syncWorkbenchNow = (convexUrl: string, token: string): Promise<number> => invoke('sync_workbench_now', { convexUrl, token });
