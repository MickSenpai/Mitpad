// src-tauri/src/sync/worker.rs
//
// Motor Offline-First: sube a la nube (Convex, ver mitpad/convex/) lo que la app
// dejó en la cola local `sync_queue`. Cada operación se borra de la cola solo
// cuando la nube la confirma; si no hay red, se reintenta en la siguiente vuelta.
//
// La cola es "de estado final": hay como mucho una operación pendiente por
// registro (ver db/queries.rs), así que un fallo no bloquea a las demás notas.
//
// Ante un error la operación no se pierde: se anota el motivo y se reintenta
// hasta MAX_INTENTOS veces. Pasado ese límite queda en estado 'failed' (visible
// en la interfaz, y se puede reintentar o descartar) en lugar de atascar la
// cola para siempre.
use convex::{ConvexClient, FunctionResult, Value};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::sleep;

use super::config::{leer_config, Config};

/// Intentos antes de dar una operación por fallida.
const MAX_INTENTOS: i64 = 5;
/// Operaciones leídas de la cola en cada vuelta.
const LOTE: i64 = 50;

/// Una operación pendiente de la cola.
struct Tarea {
    id: i64,
    operation: String,
    payload: serde_json::Value,
}

/// Resultado de intentar subir una operación.
enum Envio {
    Hecho,
    Rechazado(String),
}

fn texto(payload: &serde_json::Value, campo: &str) -> Value {
    match payload[campo].as_str() {
        Some(s) => Value::from(s),
        None => Value::Null,
    }
}

/// La llamada a la nube para una operación de la cola (None si no se reconoce).
fn llamada(
    operation: &str,
    payload: &serde_json::Value,
    token: &str,
) -> Option<(&'static str, BTreeMap<String, Value>)> {
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
            let tasks = leer_tareas(&db_path);
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
            // El cliente se saca de la variable para poder soltarlo si la red falla.
            let Some(mut convex) = cliente.take() else {
                continue;
            };
            let mut reconectar = false;

            // FASE 2: ENVÍO
            for tarea in tasks {
                match enviar(&mut convex, &tarea, &config).await {
                    Ok(Envio::Hecho) => {
                        println!(
                            "✅ [Worker] {} OK: {}",
                            tarea.operation, tarea.payload["id"]
                        );
                        limpiar_hecho(&db_path, &tarea);
                    }
                    Ok(Envio::Rechazado(motivo)) => {
                        println!(
                            "❌ [Worker] La nube rechazó {}: {}",
                            tarea.operation, motivo
                        );
                        registrar_fallo(&db_path, tarea.id, &motivo);
                    }
                    Err(motivo) => {
                        println!("❌ [Worker] Error de red ({}): {}", tarea.operation, motivo);
                        reconectar = true; // que la siguiente vuelta reconecte
                        registrar_error_red(&db_path, tarea.id, &motivo);
                        break;
                    }
                }
            }

            if !reconectar {
                cliente = Some(convex);
            }
        }
    });
}

/// Sube una operación a la nube.
async fn enviar(
    convex: &mut ConvexClient,
    tarea: &Tarea,
    config: &Config,
) -> Result<Envio, String> {
    let Some((nombre, args)) = llamada(&tarea.operation, &tarea.payload, &config.token) else {
        return Ok(Envio::Rechazado(
            "El sincronizador no sabe enviar esta operación.".to_string(),
        ));
    };

    match convex.mutation(nombre, args).await {
        Ok(FunctionResult::Value(valor)) => {
            // notes:crear devuelve false si la nota ya existe, y notes:actualizar
            // devuelve false si no existe. En ambos casos la nube y la app no
            // coinciden: se reintenta con la otra operación para converge.
            let ya_existe = matches!(valor, Value::Boolean(false));
            if !ya_existe || tarea.operation == "DELETE" {
                // Borrar una nota que la nube no tiene también es un éxito.
                return Ok(Envio::Hecho);
            }
            let contraria = if tarea.operation == "INSERT" {
                "UPDATE"
            } else {
                "INSERT"
            };
            let Some((nombre2, args2)) = llamada(contraria, &tarea.payload, &config.token) else {
                return Ok(Envio::Hecho);
            };
            match convex.mutation(nombre2, args2).await {
                Ok(FunctionResult::Value(_)) => Ok(Envio::Hecho),
                Ok(FunctionResult::ErrorMessage(e)) => Ok(Envio::Rechazado(e)),
                Ok(FunctionResult::ConvexError(e)) => Ok(Envio::Rechazado(e.message)),
                Err(e) => Err(e.to_string()),
            }
        }
        Ok(FunctionResult::ErrorMessage(e)) => Ok(Envio::Rechazado(e)),
        Ok(FunctionResult::ConvexError(e)) => Ok(Envio::Rechazado(e.message)),
        Err(e) => Err(e.to_string()),
    }
}

/// Lee las operaciones pendientes de la cola.
fn leer_tareas(db_path: &PathBuf) -> Vec<Tarea> {
    let Ok(sqlite_conn) = Connection::open(db_path) else {
        return Vec::new();
    };
    let _ = sqlite_conn.busy_timeout(Duration::from_secs(5));
    let Ok(mut stmt) = sqlite_conn.prepare(
        "SELECT id, operation, payload FROM sync_queue
          WHERE status = 'pending' ORDER BY id LIMIT ?1",
    ) else {
        return Vec::new();
    };
    let Ok(filas) = stmt.query_map([LOTE], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    }) else {
        return Vec::new();
    };

    let mut tareas = Vec::new();
    let mut corruptas = Vec::new();
    for fila in filas.flatten() {
        let (id, operation, payload) = fila;
        match payload.and_then(|p| serde_json::from_str(&p).ok()) {
            Some(p) => tareas.push(Tarea {
                id,
                operation,
                payload: p,
            }),
            None => corruptas.push(id),
        }
    }
    // Fuera del bucle: escribir en la base de datos con una lectura abierta
    // puede bloquear la base.
    for id in corruptas {
        registrar_fallo(db_path, id, "La operación en la cola está corrupta.");
    }
    tareas
}

/// La nube confirmó la operación: se borra de la cola y se anota la nota.
fn limpiar_hecho(db_path: &PathBuf, tarea: &Tarea) {
    let Ok(conn) = Connection::open(db_path) else {
        return;
    };
    let _ = conn.busy_timeout(Duration::from_secs(5));

    if tarea.operation != "DELETE" {
        if let Some(id) = tarea.payload["id"].as_str() {
            // La carga va con la fecha que se subió; si el payload es antiguo
            // (sin updated_at) se usa la fecha local de la nota.
            let subido = tarea.payload["updated_at"].as_i64();
            let _ = conn.execute(
                "UPDATE notes
                    SET synced_at = COALESCE(?1, updated_at)
                  WHERE id = ?2
                    AND (synced_at IS NULL OR synced_at < COALESCE(?1, updated_at))",
                rusqlite::params![subido, id],
            );
        }
    }

    let _ = conn.execute(
        "DELETE FROM sync_queue WHERE id = ?1",
        rusqlite::params![tarea.id],
    );
    let _ = conn.execute(
        "INSERT INTO app_state (key, value) VALUES ('last_sync_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![crate::db::ahora_ms().to_string()],
    );
}

/// Anota el fallo y, pasado MAX_INTENTOS, aparta la operación.
fn registrar_fallo(db_path: &PathBuf, id: i64, motivo: &str) {
    let Ok(conn) = Connection::open(db_path) else {
        return;
    };
    let _ = conn.busy_timeout(Duration::from_secs(5));
    let _ = conn.execute(
        "UPDATE sync_queue
            SET attempts = attempts + 1,
                last_error = ?2,
                last_attempt_at = ?3,
                status = CASE WHEN attempts + 1 >= ?4 THEN 'failed' ELSE 'pending' END
          WHERE id = ?1",
        rusqlite::params![id, motivo, crate::db::ahora_ms(), MAX_INTENTOS],
    );
}

/// Anota un problema de red. No cuenta como intento: una avería de conexión
/// no debe dejar la nota apartada, solo pendiente de reintentarse.
fn registrar_error_red(db_path: &PathBuf, id: i64, motivo: &str) {
    let Ok(conn) = Connection::open(db_path) else {
        return;
    };
    let _ = conn.busy_timeout(Duration::from_secs(5));
    let _ = conn.execute(
        "UPDATE sync_queue SET last_error = ?2, last_attempt_at = ?3 WHERE id = ?1",
        rusqlite::params![id, motivo, crate::db::ahora_ms()],
    );
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

    #[test]
    fn el_insert_necesita_usuario_para_recrear_la_nota() {
        // Si la nube dice que la nota ya existe, el worker reintenta como UPDATE;
        // si dice que no existe, reintenta como INSERT (y necesita user_id).
        let p = serde_json::json!({"id": "n1", "user_id": "u1", "title": null, "content": "c"});
        let (_, args) = llamada("INSERT", &p, "tok").unwrap();
        assert!(args.contains_key("userId"));
    }

    // ------------------------------------------------------------------
    // La cola no se atasca: un fallo deja solo esa operación aparcada.
    // ------------------------------------------------------------------

    fn cola_de_prueba() -> (PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!(
            "mitpad-worker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let ruta = dir.join("cola.db");
        let conn = Connection::open(&ruta).unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, updated_at INTEGER, synced_at INTEGER);
             CREATE TABLE sync_queue (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 operation TEXT, table_name TEXT, record_id TEXT, payload TEXT,
                 status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,
                 last_error TEXT, created_at INTEGER, last_attempt_at INTEGER);
             CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
        (ruta, conn)
    }

    #[test]
    fn un_fallo_no_arrastra_a_las_demas_operaciones() {
        let (ruta, conn) = cola_de_prueba();
        conn.execute(
            "INSERT INTO sync_queue (operation, table_name, record_id, payload, created_at)
             VALUES ('INSERT', 'notes', 'mala', '{}', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (operation, table_name, record_id, payload, created_at)
             VALUES ('INSERT', 'notes', 'buena', '{}', 2)",
            [],
        )
        .unwrap();
        drop(conn);

        // La mala operación falla hasta agotar los intentos.
        for _ in 0..MAX_INTENTOS {
            registrar_fallo(&ruta, 1, "Nota demasiado larga.");
        }

        let conn = Connection::open(&ruta).unwrap();
        let (estado, intentos): (String, i64) = conn
            .query_row(
                "SELECT status, attempts FROM sync_queue WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(estado, "failed");
        assert_eq!(intentos, MAX_INTENTOS);

        // La otra operación sigue pendiente: la cola no se atasca.
        let estado: String = conn
            .query_row("SELECT status FROM sync_queue WHERE id = 2", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(estado, "pending");

        // Y el motivo del fallo queda a la vista.
        let motivo: String = conn
            .query_row("SELECT last_error FROM sync_queue WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(motivo, "Nota demasiado larga.");
    }

    #[test]
    fn un_error_de_red_no_deja_la_nota_apartada() {
        let (ruta, conn) = cola_de_prueba();
        conn.execute(
            "INSERT INTO sync_queue (operation, table_name, record_id, payload, created_at)
             VALUES ('INSERT', 'notes', 'n1', '{}', 1)",
            [],
        )
        .unwrap();
        drop(conn);

        // Aunque la red falle muchas veces, la operación sigue pendiente.
        for _ in 0..(MAX_INTENTOS * 3) {
            registrar_error_red(&ruta, 1, "error de red");
        }

        let conn = Connection::open(&ruta).unwrap();
        let (estado, intentos): (String, i64) = conn
            .query_row(
                "SELECT status, attempts FROM sync_queue WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(estado, "pending");
        assert_eq!(intentos, 0, "un fallo de red no consume intentos");
        let motivo: String = conn
            .query_row("SELECT last_error FROM sync_queue WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(motivo, "error de red");
    }

    #[test]
    fn al_subir_se_marca_la_nota_como_sincronizada() {
        let (ruta, conn) = cola_de_prueba();
        conn.execute(
            "INSERT INTO notes (id, updated_at, synced_at) VALUES ('n1', 100, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (operation, table_name, record_id, payload, created_at)
             VALUES ('INSERT', 'notes', 'n1', '{\"id\":\"n1\",\"updated_at\":100}', 1)",
            [],
        )
        .unwrap();
        drop(conn);

        let tarea = Tarea {
            id: 1,
            operation: "INSERT".to_string(),
            payload: serde_json::json!({"id": "n1", "updated_at": 100}),
        };
        limpiar_hecho(&ruta, &tarea);

        let conn = Connection::open(&ruta).unwrap();
        let synced: Option<i64> = conn
            .query_row("SELECT synced_at FROM notes WHERE id = 'n1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(synced, Some(100));
        let cola: i64 = conn
            .query_row("SELECT count(*) FROM sync_queue", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cola, 0, "la operación se borra de la cola");
        let ultimo: String = conn
            .query_row(
                "SELECT value FROM app_state WHERE key = 'last_sync_at'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ultimo.parse::<i64>().unwrap() > 0);
    }
}
