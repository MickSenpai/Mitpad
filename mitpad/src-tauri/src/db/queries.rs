use rusqlite::Connection;
use tauri::State;
use std::sync::Mutex;
use uuid::Uuid;
use super::models::Note;

pub struct DbState(pub Mutex<Connection>);

#[tauri::command]
pub fn create_note(
    title: Option<String>, // Recibimos el título como opcional desde Svelte
    content: String,       // El contenido ahora es obligatorio
    user_id: String, 
    state: State<DbState>
) -> Result<Note, String> {
    let conn = state.0.lock().map_err(|_| "Error al bloquear el Mutex de SQLite".to_string())?;
    let note_id = Uuid::new_v4().to_string();
    
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // Nota de Tutor: rusqlite maneja los Option automáticamente, insertando NULL en SQLite si llega un None.
    tx.execute(
        "INSERT INTO notes (id, user_id, title, content) VALUES (?1, ?2, ?3, ?4)",
        (&note_id, &user_id, &title, &content),
    ).map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "id": note_id,
        "user_id": user_id,
        "title": title,
        "content": content
    }).to_string();

    tx.execute(
        "INSERT INTO sync_queue (operation, table_name, record_id, payload) 
         VALUES ('INSERT', 'notes', ?1, ?2)",
        (&note_id, &payload),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    Ok(Note {
        id: note_id,
        user_id,
        title,
        content,
        created_at: "".to_string(), 
        updated_at: "".to_string(),
    })
}

#[tauri::command]
pub fn update_note(
    state: tauri::State<'_, DbState>,
    id: String,
    title: Option<String>,
    content: String,
) -> Result<(), String> {
    let conn = state.0.lock().unwrap();

    // 1. Actualizamos la nota localmente
    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
        rusqlite::params![title, content, id],
    ).map_err(|e| e.to_string())?;

    // 2. Encolamos la operación UPDATE (Armamos un JSON mínimo con los cambios)
    let payload = serde_json::json!({
        "id": id,
        "title": title,
        "content": content
    });

    conn.execute(
        "INSERT INTO sync_queue (operation, table_name, record_id, payload) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params!["UPDATE", "notes", id, payload.to_string()],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn delete_note(state: tauri::State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();

    // 1. Borramos la nota localmente
    conn.execute("DELETE FROM notes WHERE id = ?1", rusqlite::params![&id])
        .map_err(|e| e.to_string())?;

    // 2. Encolamos la operación DELETE (No necesitamos payload complejo, solo el ID)
    let payload = serde_json::json!({ "id": id });

    conn.execute(
        "INSERT INTO sync_queue (operation, table_name, record_id, payload) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params!["DELETE", "notes", id, payload.to_string()],
    ).map_err(|e| e.to_string())?;

    Ok(())
}