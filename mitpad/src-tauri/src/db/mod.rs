// src-tauri/src/db/mod.rs

pub mod models;
pub mod queries;

use rusqlite::{Connection, Result};
use std::fs;
use tauri::AppHandle;
use tauri::Manager;

pub fn init_db(app_handle: &AppHandle) -> Result<Connection> {

let app_dir = app_handle.path().app_data_dir()
        .expect("Error crítico: No se pudo resolver el directorio de datos de la app");
    
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).expect("Error al crear el directorio base");
    }

    let db_path = app_dir.join("mitpad_local.db");
    let conn = Connection::open(db_path)?;

    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    

    // Optimizaciones para Offline-First
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;"
    )?;

    // Inicialización del Schema Espejo
    conn.execute_batch(
        "
        -- Tabla espejo: Notas (Alineada con Neontech)
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT,            -- Opcional
            content TEXT NOT NULL, -- Obligatorio
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Tabla espejo: Relaciones tipo Obsidian
        CREATE TABLE IF NOT EXISTS note_links (
            id TEXT PRIMARY KEY,
            source_note_id TEXT NOT NULL,
            target_note_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (source_note_id) REFERENCES notes (id) ON DELETE CASCADE,
            FOREIGN KEY (target_note_id) REFERENCES notes (id) ON DELETE CASCADE,
            UNIQUE(source_note_id, target_note_id)
        );

        -- Motor Offline-First: Cola de Mutaciones
        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
            table_name TEXT NOT NULL CHECK(table_name IN ('notes', 'note_links')),
            record_id TEXT NOT NULL,
            payload TEXT,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'failed')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        "
    )?;

    Ok(conn)
}