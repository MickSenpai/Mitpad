import { invoke } from '@tauri-apps/api/core';

// 1. Definimos la interfaz reflejando exactamente el modelo Note de Rust
export interface Note {
    id: string;
    user_id: string;
    title: string | null; // Refleja el Option<String> de Rust
    content: string;
    created_at: string;
    updated_at: string;
}

// 2. Función asíncrona para llamar a Rust (Crear)
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

// 3. Función asíncrona para llamar a Rust (Actualizar)
export async function updateLocalNote(id: string, title: string, content: string): Promise<void> {
    const cleanTitle = title.trim() === "" ? null : title.trim();

    try {
        await invoke('update_note', { 
            id: id, 
            title: cleanTitle, 
            content: content 
        });
    } catch (error) {
        console.error("Fallo el IPC hacia Rust (Actualizar):", error);
        throw error;
    }
}

// 4. Función asíncrona para llamar a Rust (Borrar)
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