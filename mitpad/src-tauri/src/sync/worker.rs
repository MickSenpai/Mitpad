
// src-tauri/src/sync/worker.rs
use rusqlite::Connection;
use sqlx::postgres::PgPoolOptions;
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::sleep;
use serde_json::Value;

pub fn start_background_worker(db_path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        println!("🚀 [Worker] Motor Offline-First iniciado...");

        let pg_pool = PgPoolOptions::new()
            .max_connections(3)
            // IMPORTANTE: Pon tu URL real de Neontech aquí
            .connect_lazy("postgresql://neondb_owner:npg_F9jNhkIReo0a@ep-restless-poetry-aibqb7ym-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require")
            .expect("URL inválida");

        loop {
            sleep(Duration::from_secs(5)).await;

            // FASE 1: LECTURA AISLADA
            let tasks = {
                let sqlite_conn = match Connection::open(&db_path) {
                    Ok(conn) => {
                        let _ = conn.busy_timeout(Duration::from_secs(5)); // 👈 Paciencia
                        conn
                    },
                    Err(_) => continue, 
                };

                let mut stmt = match sqlite_conn.prepare(
                    "SELECT id, operation, payload FROM sync_queue WHERE status = 'pending' LIMIT 10"
                ) {
                    Ok(stmt) => stmt,
                    Err(_) => continue,
                };

                let mut tasks_temp = Vec::new();
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,     
                        row.get::<_, String>(1)?,  
                        row.get::<_, String>(2)?,  
                    ))
                }) {
                    for row in rows.flatten() { tasks_temp.push(row); }
                }
                tasks_temp 
            }; 

            if tasks.is_empty() { continue; }

            // FASE 2: ENVÍO ASÍNCRONO
            for (queue_id, operation, payload_str) in tasks {
                let mut success = false;

                if let Ok(payload) = serde_json::from_str::<Value>(&payload_str) {
                    let note_id = payload["id"].as_str().unwrap_or_default();

                    match operation.as_str() {
                        "INSERT" => {
                            let user_id = payload["user_id"].as_str().unwrap_or_default();
                            let title = payload["title"].as_str(); 
                            let content = payload["content"].as_str().unwrap_or_default();

                            match sqlx::query(
                                "INSERT INTO notes (id, user_id, title, content) VALUES ($1::uuid, $2::uuid, $3, $4) ON CONFLICT (id) DO NOTHING"
                            )
                            .bind(note_id).bind(user_id).bind(title).bind(content)
                            .execute(&pg_pool).await {
                                Ok(_) => { success = true; println!("✅ [Worker] INSERCIÓN exitosa: {}", note_id); },
                                Err(e) => println!("❌ [Worker] Error Postgres (INSERT): {}", e), // 👈 Revelamos el error real
                            }
                        }
                        "UPDATE" => {
                            let title = payload["title"].as_str(); 
                            let content = payload["content"].as_str().unwrap_or_default();

                            match sqlx::query(
                                "UPDATE notes SET title = $1, content = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3::uuid"
                            )
                            .bind(title).bind(content).bind(note_id)
                            .execute(&pg_pool).await {
                                Ok(_) => { success = true; println!("✅ [Worker] EDICIÓN exitosa: {}", note_id); },
                                Err(e) => println!("❌ [Worker] Error Postgres (UPDATE): {}", e),
                            }
                        }
                        "DELETE" => {
                            match sqlx::query("DELETE FROM notes WHERE id = $1::uuid")
                            .bind(note_id)
                            .execute(&pg_pool).await {
                                Ok(_) => { success = true; println!("🗑️ [Worker] BORRADO exitoso: {}", note_id); },
                                Err(e) => println!("❌ [Worker] Error Postgres (DELETE): {}", e),
                            }
                        }
                        _ => {}
                    }
                }

                // FASE 3: ACTUALIZAR ESTADO LOCAL
                if success {
                    if let Ok(update_conn) = Connection::open(&db_path) {
                        let _ = update_conn.busy_timeout(Duration::from_secs(5)); 
                        // 👇 Borramos la tarea de la cola en lugar de cambiarle el estatus
                        let res = update_conn.execute(
                            "DELETE FROM sync_queue WHERE id = ?1",
                            rusqlite::params![queue_id], 
                        );
                        if let Err(e) = res {
                            println!("⚠️ [Worker] Error al limpiar la cola: {}", e);
                        }
                    }
                }
            }
        }
    });
}