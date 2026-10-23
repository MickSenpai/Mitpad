import { invoke } from '@tauri-apps/api/core';

// Puente entre la interfaz y los comandos de Rust (src-tauri/src/db/queries.rs).
// Las fechas son milisegundos desde 1970, el mismo formato que usa Convex.

// 1. Definimos la interfaz reflejando exactamente el modelo Note de Rust
export interface Note {
    id: string;
    user_id: string;
    title: string | null; // Refleja el Option<String> de Rust
    content: string;
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

// 5. Función asíncrona para llamar a Rust (Borrar)
export async function deleteLocalNote(id: string): Promise<void> {
    try {
        await invoke('delete_note', {
            id: id
        });
    } catch (error) {
        console.error("Fallo el IPC hacia Rust (Borrar):", error);
        throw error;
    }
}

// 6. Todas las notas locales (la más reciente primero)
export async function listLocalNotes(): Promise<Note[]> {
    return await invoke('list_notes');
}

// 7. Estado de la sincronización
export async function getSyncStatus(): Promise<SyncStatus> {
    return await invoke('sync_status');
}

// 8. Devuelve a la cola las operaciones que fallaron
export async function retryFailedSync(): Promise<number> {
    return await invoke('retry_failed');
}

// 9. Trae las notas de la nube y las fusiona con las locales
export async function pullCloudNotes(userId: string): Promise<Note[]> {
    return await invoke('pull_notes', { userId: userId });
}
