// src-tauri/src/sync/worker.rs
//
// Motor Offline-First: sube a la nube (Convex, ver mitpad/convex/) lo que la app
// dejó en la cola local `sync_queue`. Cada operación se borra de la cola solo
// cuando la nube la confirma; si no hay red, se reintenta en la siguiente vuelta.
//
// Configuración (NUNCA en el código):
//   - MITPAD_CONVEX_URL: https://<despliegue>.convex.cloud (variable de entorno, o
//     la que se fijó al compilar con la misma variable)
//   - MITPAD_TOKEN: token de la app (variable de entorno, o la línea
//     MITPAD_TOKEN=... de ~/.config/mitpad/convex_token.env)
use convex::{ConvexClient, FunctionResult, Value};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::sleep;

struct Config {
    url: String,
    token: String,
}

fn leer_config() -> Option<Config> {
    let url = std::env::var("MITPAD_CONVEX_URL")
        .ok()
        .or_else(|| option_env!("MITPAD_CONVEX_URL").map(String::from))?;
    let token = std::env::var("MITPAD_TOKEN").ok().or_else(|| {
        let ruta = dirs::config_dir()?.join("mitpad").join("convex_token.env");
        std::fs::read_to_string(ruta)
            .ok()?
            .lines()
            .find_map(|l| l.strip_prefix("MITPAD_TOKEN=").map(|t| t.trim().to_string()))
    })?;
    (!url.is_empty() && !token.is_empty()).then_some(Config { url, token })
}

fn texto(payload: &serde_json::Value, campo: &str) -> Value {
    match payload[campo].as_str() {
        Some(s) => Value::from(s),
        None => Value::Null,
    }
}

/// La llamada a la nube para una operación de la cola (None si no se reconoce).
fn llamada(operation: &str, payload: &serde_json::Value, token: &str) -> Option<(&'static str, BTreeMap<String, Value>)> {
    let mut args = BTreeMap::new();
    args.insert("token".to_string(), Value::from(token));
    args.insert("id".to_string(), texto(payload, "id"));
    let nombre = match operation {
        "INSERT" => {
            args.insert("userId".to_string(), texto(payload, "user_id"));
            args.insert("title".to_string(), texto(payload, "title"));
            args.insert("content".to_string(), texto(payload, "content"));
            "notes:crear"
        }
        "UPDATE" => {
            args.insert("title".to_string(), texto(payload, "title"));
            args.insert("content".to_string(), texto(payload, "content"));
            "notes:actualizar"
        }
        "DELETE" => "notes:borrar",
        _ => return None,
    };
    Some((nombre, args))
}

pub fn start_background_worker(db_path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let Some(config) = leer_config() else {
            println!("⚠️ [Worker] Sin MITPAD_CONVEX_URL / MITPAD_TOKEN: las notas se quedan solo en este equipo.");
            return;
        };
        println!("🚀 [Worker] Motor Offline-First iniciado...");
        let mut cliente: Option<ConvexClient> = None;

        loop {
            sleep(Duration::from_secs(5)).await;

            // FASE 1: LECTURA AISLADA
            let tasks = {
                let sqlite_conn = match Connection::open(&db_path) {
                    Ok(conn) => {
                        let _ = conn.busy_timeout(Duration::from_secs(5));
                        conn
                    }
                    Err(_) => continue,
                };
                let mut stmt = match sqlite_conn.prepare(
                    "SELECT id, operation, payload FROM sync_queue WHERE status = 'pending' ORDER BY id LIMIT 10",
                ) {
                    Ok(stmt) => stmt,
                    Err(_) => continue,
                };
                let mut tasks_temp = Vec::new();
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                }) {
                    for row in rows.flatten() {
                        tasks_temp.push(row);
                    }
                }
                tasks_temp
            };

            if tasks.is_empty() {
                continue;
            }

            // Conectar solo cuando hay algo que subir (y reconectar si la conexión cayó)
            if cliente.is_none() {
                match ConvexClient::new(&config.url).await {
                    Ok(c) => cliente = Some(c),
                    Err(e) => {
                        println!("❌ [Worker] Sin conexión con la nube: {}", e);
                        continue;
                    }
                }
            }
            let Some(convex) = cliente.as_mut() else { continue };

            // FASE 2: ENVÍO (en orden: crear antes de editar o borrar)
            for (queue_id, operation, payload_str) in tasks {
                let Ok(payload) = serde_json::from_str::<serde_json::Value>(&payload_str) else {
                    println!("⚠️ [Worker] Operación {} ilegible; se queda en la cola.", queue_id);
                    continue;
                };
                let Some((nombre, args)) = llamada(&operation, &payload, &config.token) else {
                    continue;
                };
                let success = match convex.mutation(nombre, args).await {
                    Ok(FunctionResult::Value(_)) => {
                        println!("✅ [Worker] {} OK: {}", operation, payload["id"]);
                        true
                    }
                    Ok(FunctionResult::ErrorMessage(e)) => {
                        println!("❌ [Worker] La nube rechazó {}: {}", operation, e);
                        false
                    }
                    Ok(FunctionResult::ConvexError(e)) => {
                        println!("❌ [Worker] La nube rechazó {}: {}", operation, e.message);
                        false
                    }
                    Err(e) => {
                        println!("❌ [Worker] Error de red ({}): {}", operation, e);
                        cliente = None; // que la siguiente vuelta reconecte
                        break;
                    }
                };

                // FASE 3: ACTUALIZAR ESTADO LOCAL
                if success {
                    if let Ok(update_conn) = Connection::open(&db_path) {
                        let _ = update_conn.busy_timeout(Duration::from_secs(5));
                        if let Err(e) =
                            update_conn.execute("DELETE FROM sync_queue WHERE id = ?1", rusqlite::params![queue_id])
                        {
                            println!("⚠️ [Worker] Error al limpiar la cola: {}", e);
                        }
                    }
                } else {
                    // Si una falla, no seguir: editar o borrar una nota que no se creó también fallaría
                    break;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_lleva_todo_y_titulo_nulo() {
        let p = serde_json::json!({"id": "n1", "user_id": "u1", "title": null, "content": "hola"});
        let (nombre, args) = llamada("INSERT", &p, "tok").unwrap();
        assert_eq!(nombre, "notes:crear");
        assert!(matches!(args["title"], Value::Null));
        assert!(matches!(&args["userId"], Value::String(s) if s == "u1"));
        assert!(matches!(&args["token"], Value::String(s) if s == "tok"));
    }

    #[test]
    fn update_y_delete() {
        let p = serde_json::json!({"id": "n1", "title": "t", "content": "c"});
        assert_eq!(llamada("UPDATE", &p, "tok").unwrap().0, "notes:actualizar");
        let (nombre, args) = llamada("DELETE", &serde_json::json!({"id": "n1"}), "tok").unwrap();
        assert_eq!(nombre, "notes:borrar");
        assert!(!args.contains_key("content"));
        assert!(llamada("OTRA", &p, "tok").is_none());
    }
}
