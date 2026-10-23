// src-tauri/src/sync/pull.rs
//
// Trae de la nube (Convex) las notas de un usuario y las fusiona con las
// locales. Reglas:
//   - Una nota que no está localmente se inserta (sin encolar nada: viene de
//     la nube, no hay que volver a subirla).
//   - Una nota local más antigua que la de la nube se actualiza, salvo que
//     tenga cambios locales sin subir (en ese caso gana lo local).
use convex::{ConvexClient, FunctionResult, Value};
use rusqlite::params;
use std::collections::BTreeMap;
use tauri::State;

use crate::db::models::Note;
use crate::db::queries::{list_notes, DbState};

use super::config::leer_config;

/// Cuántas notas se bajan de la nube en cada llamada.
const LIMITE: i64 = 500;

/// Descarga las notas de la nube y las fusiona con las locales.
#[tauri::command]
pub async fn pull_notes(state: State<'_, DbState>, user_id: String) -> Result<Vec<Note>, String> {
    let Some(config) = leer_config() else {
        return Err(
            "Sin MITPAD_CONVEX_URL / MITPAD_TOKEN no se puede traer nada de la nube.".to_string(),
        );
    };

    let mut cliente = ConvexClient::new(&config.url)
        .await
        .map_err(|e| format!("Error de red: {e}"))?;

    let mut args = BTreeMap::new();
    args.insert("token".to_string(), Value::from(config.token.clone()));
    args.insert("userId".to_string(), Value::from(user_id.clone()));
    args.insert("limite".to_string(), Value::from(LIMITE));

    let resultado = cliente
        .query("notes:listar", args)
        .await
        .map_err(|e| format!("Error de red: {e}"))?;

    let FunctionResult::Value(Value::Array(filas)) = resultado else {
        return Err("La nube devolvió una respuesta inesperada.".to_string());
    };

    let remotas: Vec<NotaRemota> = filas.iter().filter_map(NotaRemota::from_value).collect();

    {
        let conn = state
            .inner()
            .0
            .lock()
            .map_err(|_| "Error al bloquear el Mutex de SQLite".to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        for nota in &remotas {
            let local: Option<(i64, Option<i64>)> = tx
                .query_row(
                    "SELECT updated_at, synced_at FROM notes WHERE id = ?1",
                    params![&nota.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();

            match local {
                // No está en este equipo: se trae tal cual.
                None => {
                    tx.execute(
                        "INSERT INTO notes (id, user_id, title, content, created_at, updated_at, synced_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                        params![
                            &nota.id,
                            &nota.user_id,
                            &nota.title,
                            &nota.content,
                            nota.created_at,
                            nota.updated_at
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
                Some((updated_at, _synced_at)) => {
                    // Si hay cambios locales sin subir, lo local gana.
                    let pendientes: i64 = tx
                        .query_row(
                            "SELECT count(*) FROM sync_queue
                              WHERE table_name = 'notes' AND record_id = ?1 AND status = 'pending'",
                            params![&nota.id],
                            |r| r.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    if pendientes == 0 && nota.updated_at > updated_at {
                        tx.execute(
                            "UPDATE notes
                                SET title = ?1, content = ?2, updated_at = ?3, synced_at = ?3
                              WHERE id = ?4",
                            params![&nota.title, &nota.content, nota.updated_at, &nota.id],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
        }

        tx.commit().map_err(|e| e.to_string())?;
    }

    list_notes(state)
}

/// Una nota tal y como la devuelve la nube.
struct NotaRemota {
    id: String,
    user_id: String,
    title: Option<String>,
    content: String,
    created_at: i64,
    updated_at: i64,
}

impl NotaRemota {
    fn from_value(valor: &Value) -> Option<Self> {
        let Value::Object(obj) = valor else {
            return None;
        };
        let id = texto(obj, "id")?;
        let content = texto(obj, "content").unwrap_or_default();
        Some(NotaRemota {
            id,
            user_id: texto(obj, "user_id").unwrap_or_default(),
            title: texto(obj, "title"),
            content,
            created_at: numero(obj, "created_at").unwrap_or(0),
            updated_at: numero(obj, "updated_at").unwrap_or(0),
        })
    }
}

fn texto(obj: &BTreeMap<String, Value>, clave: &str) -> Option<String> {
    match obj.get(clave) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn numero(obj: &BTreeMap<String, Value>, clave: &str) -> Option<i64> {
    match obj.get(clave) {
        Some(Value::Int64(n)) => Some(*n),
        Some(Value::Float64(f)) => Some(*f as i64),
        _ => None,
    }
}
