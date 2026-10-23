// src-tauri/src/db/queries.rs
//! Comandos Tauri sobre la base de datos local.
//!
//! Regla de la cola: como mucho hay una operación pendiente por registro. Al
//! editar o borrar una nota se sustituye la operación anterior por la nueva,
//! así el worker sube el estado final y no una secuencia de cambios. Además,
//! una nota que nunca llegó a la nube se vuelve a subir como INSERT (no como
//! UPDATE, que la nube descartaría en silencio).
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

use super::ahora_ms;
use super::models::{Note, SyncStatus};

pub struct DbState(pub Mutex<Connection>);

/// Error de negocio (se muestra tal cual en la interfaz).
type Error = String;

fn bloquear<'r>(state: State<'r, DbState>) -> Result<std::sync::MutexGuard<'r, Connection>, Error> {
    state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear el Mutex de SQLite".to_string())
}

// ---------------------------------------------------------------------------
// Cola de sincronización
// ---------------------------------------------------------------------------

/// Sustituye la operación pendiente de un registro por otra.
fn encolar(
    tx: &Transaction,
    operacion: &str,
    tabla: &str,
    registro: &str,
    payload: &serde_json::Value,
) -> Result<(), Error> {
    limpiar_cola(tx, tabla, registro)?;
    tx.execute(
        "INSERT INTO sync_queue (operation, table_name, record_id, payload, status, attempts, created_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5)",
        params![operacion, tabla, registro, payload.to_string(), ahora_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Borra todas las operaciones (pendientes o fallidas) de un registro.
fn limpiar_cola(tx: &Transaction, tabla: &str, registro: &str) -> Result<(), Error> {
    tx.execute(
        "DELETE FROM sync_queue WHERE table_name = ?1 AND record_id = ?2",
        params![tabla, registro],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Notas
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn create_note(
    title: Option<String>,
    content: String,
    user_id: String,
    state: State<'_, DbState>,
) -> Result<Note, Error> {
    let conn = bloquear(state)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let ahora = ahora_ms();

    tx.execute(
        "INSERT INTO notes (id, user_id, title, content, created_at, updated_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL)",
        params![&id, &user_id, &title, &content, ahora],
    )
    .map_err(|e| e.to_string())?;

    let payload = json!({
        "id": id,
        "user_id": user_id,
        "title": title,
        "content": content,
        "updated_at": ahora,
    });
    encolar(&tx, "INSERT", "notes", &id, &payload)?;

    tx.commit().map_err(|e| e.to_string())?;

    Ok(Note {
        id,
        user_id,
        title,
        content,
        created_at: ahora,
        updated_at: ahora,
        synced_at: None,
    })
}

#[tauri::command]
pub fn update_note(
    state: State<'_, DbState>,
    id: String,
    title: Option<String>,
    content: String,
) -> Result<Note, Error> {
    let conn = bloquear(state)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let (user_id, synced_at, created_at): (String, Option<i64>, i64) = tx
        .query_row(
            "SELECT user_id, synced_at, created_at FROM notes WHERE id = ?1",
            params![&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("La nota {id} no existe."))?;

    let ahora = ahora_ms();
    tx.execute(
        "UPDATE notes SET title = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
        params![&title, &content, ahora, &id],
    )
    .map_err(|e| e.to_string())?;

    // La carga va siempre con el contenido completo: si la nube no conoce la
    // nota hay que crearla, si la conoce hay que actualizarla.
    let payload = json!({
        "id": id,
        "user_id": user_id,
        "title": title,
        "content": content,
        "updated_at": ahora,
    });
    if synced_at.is_none() {
        encolar(&tx, "INSERT", "notes", &id, &payload)?;
    } else {
        encolar(&tx, "UPDATE", "notes", &id, &payload)?;
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(Note {
        id,
        user_id,
        title,
        content,
        created_at,
        updated_at: ahora,
        synced_at,
    })
}

#[tauri::command]
pub fn delete_note(state: State<'_, DbState>, id: String) -> Result<(), Error> {
    let conn = bloquear(state)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM notes WHERE id = ?1", params![&id])
        .map_err(|e| e.to_string())?;

    // La nota desaparece: sus operaciones anteriores (incluidas las fallidas)
    // ya no sirven. Solo queda avisar a la nube de que la borre.
    limpiar_cola(&tx, "notes", &id)?;
    let payload = json!({ "id": id });
    encolar(&tx, "DELETE", "notes", &id, &payload)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Todas las notas locales, la más reciente primero.
#[tauri::command]
pub fn list_notes(state: State<'_, DbState>) -> Result<Vec<Note>, Error> {
    let conn = bloquear(state)?;
    let mut st = conn
        .prepare(
            "SELECT id, user_id, title, content, created_at, updated_at, synced_at
               FROM notes ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let notas = st
        .query_map([], |r| {
            Ok(Note {
                id: r.get(0)?,
                user_id: r.get(1)?,
                title: r.get(2)?,
                content: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                synced_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(notas)
}

// ---------------------------------------------------------------------------
// Estado de la sincronización
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn sync_status(state: State<'_, DbState>) -> Result<SyncStatus, Error> {
    let conn = bloquear(state)?;

    let pending: i64 = conn
        .query_row(
            "SELECT count(*) FROM sync_queue WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let failed: i64 = conn
        .query_row(
            "SELECT count(*) FROM sync_queue WHERE status = 'failed'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let last_error: Option<String> = conn
        .query_row(
            "SELECT last_error FROM sync_queue
              WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();

    let last_sync_at: Option<i64> = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = 'last_sync_at'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse().ok());

    Ok(SyncStatus {
        pending,
        failed,
        last_error,
        last_sync_at,
        configured: crate::sync::config::leer_config().is_some(),
    })
}

/// Devuelve a la cola las operaciones que fallaron (para reintentarlas).
#[tauri::command]
pub fn retry_failed(state: State<'_, DbState>) -> Result<i64, Error> {
    let conn = bloquear(state)?;
    let cambiadas = conn
        .execute(
            "UPDATE sync_queue
                SET status = 'pending', attempts = 0, last_error = NULL
              WHERE status = 'failed'",
            [],
        )
        .map_err(|e| e.to_string())?;
    Ok(cambiadas as i64)
}
