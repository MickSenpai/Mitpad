// src-tauri/src/db/mod.rs
//! Base de datos local de Mitpad (SQLite) y migración de esquema.
//!
//! El formato de las fechas es el mismo que usa Convex: milisegundos desde 1970
//! en un INTEGER de SQLite. Antes eran TEXT ("YYYY-MM-DD HH:MM:SS"), por lo que
//! `migrar_esquema` reconstruye las tablas si encuentra el esquema antiguo.

pub mod models;
pub mod queries;

use rusqlite::{Connection, Result};
use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Manager;

/// Milisegundos desde 1970 (formato de Convex).
pub fn ahora_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn init_db(app_handle: &AppHandle) -> Result<Connection> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .expect("Error crítico: No se pudo resolver el directorio de datos de la app");

    fs::create_dir_all(&app_dir).expect("Error al crear el directorio base");

    let db_path = app_dir.join("mitpad_local.db");
    let conn = Connection::open(db_path)?;

    conn.busy_timeout(Duration::from_secs(5))?;

    // Optimizaciones para Offline-First
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;

    crear_esquema(&conn)?;
    migrar_esquema(&conn)?;

    Ok(conn)
}

/// Esquema actual (base de datos nuevas).
fn crear_esquema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        -- Tabla espejo: Notas (alineada con Convex)
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT,                 -- Opcional
            content TEXT NOT NULL,      -- Obligatorio
            created_at INTEGER NOT NULL,-- ms desde 1970
            updated_at INTEGER NOT NULL,-- ms desde 1970
            synced_at INTEGER           -- updated_at confirmado por la nube (NULL = nunca subido)
        );

        -- Tabla espejo: Relaciones tipo Obsidian
        CREATE TABLE IF NOT EXISTS note_links (
            id TEXT PRIMARY KEY,
            source_note_id TEXT NOT NULL,
            target_note_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (source_note_id) REFERENCES notes (id) ON DELETE CASCADE,
            FOREIGN KEY (target_note_id) REFERENCES notes (id) ON DELETE CASCADE,
            UNIQUE(source_note_id, target_note_id)
        );

        -- Motor Offline-First: Cola de Mutaciones.
        -- Como máximo hay una operación pendiente por registro: al editar o borrar
        -- una nota se sustituye la anterior por la nueva (ver queries.rs).
        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
            table_name TEXT NOT NULL CHECK(table_name IN ('notes', 'note_links')),
            record_id TEXT NOT NULL,
            payload TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            last_attempt_at INTEGER
        );

        -- Estado interno de la app (última sincronización correcta, etc.)
        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        ",
    )
}

/// Actualiza bases de datos creadas por versiones anteriores.
fn migrar_esquema(conn: &Connection) -> Result<()> {
    // 1. Las fechas de TEXT a INTEGER (ms). Reconstruye las tablas afectadas.
    let notas_texto = es_texto(conn, "notes", "created_at");
    let links_texto = es_texto(conn, "note_links", "created_at");
    let cola_texto = es_texto(conn, "sync_queue", "created_at");

    if notas_texto || links_texto || cola_texto {
        // Sin claves foráneas durante la reconstrucción: DROP TABLE no debe
        // borrar en cascada las filas de note_links.
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             PRAGMA legacy_alter_table = ON;",
        )?;
        if notas_texto {
            reconstruir_notas(conn)?;
        }
        if links_texto {
            reconstruir_links(conn)?;
        }
        if cola_texto {
            reconstruir_cola(conn)?;
        }
        conn.execute_batch(
            "PRAGMA legacy_alter_table = OFF;
             PRAGMA foreign_keys = ON;",
        )?;
    }

    // 2. Columnas nuevas.
    for (columna, definicion) in [
        ("attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("last_error", "TEXT"),
        ("last_attempt_at", "INTEGER"),
    ] {
        if !tiene_columna(conn, "sync_queue", columna) {
            conn.execute_batch(&format!(
                "ALTER TABLE sync_queue ADD COLUMN {columna} {definicion}"
            ))?;
        }
    }
    if !tiene_columna(conn, "notes", "synced_at") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN synced_at INTEGER")?;
    }

    // 3. Las notas que ya estaban en la nube se marcan como sincronizadas.
    //    Las que siguen en la cola (nunca subidas) se quedan con synced_at NULL,
    //    para que el worker las vuelva a subir como INSERT.
    conn.execute_batch(
        "UPDATE notes SET synced_at = updated_at
          WHERE synced_at IS NULL
            AND id NOT IN (
                SELECT record_id FROM sync_queue
                 WHERE table_name = 'notes' AND status = 'pending'
            );",
    )?;

    Ok(())
}

fn reconstruir_notas(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE notes_nuevo (
             id TEXT PRIMARY KEY,
             user_id TEXT NOT NULL,
             title TEXT,
             content TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL,
             synced_at INTEGER
         );
         INSERT INTO notes_nuevo (id, user_id, title, content, created_at, updated_at, synced_at)
             SELECT id, user_id, title, content,
                    COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, 0),
                    COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000, 0),
                    NULL
               FROM notes;
         DROP TABLE notes;
         ALTER TABLE notes_nuevo RENAME TO notes;",
    )?;
    Ok(())
}

fn reconstruir_links(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE note_links_nuevo (
             id TEXT PRIMARY KEY,
             source_note_id TEXT NOT NULL,
             target_note_id TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             FOREIGN KEY (source_note_id) REFERENCES notes (id) ON DELETE CASCADE,
             FOREIGN KEY (target_note_id) REFERENCES notes (id) ON DELETE CASCADE,
             UNIQUE(source_note_id, target_note_id)
         );
         INSERT INTO note_links_nuevo (id, source_note_id, target_note_id, created_at)
             SELECT id, source_note_id, target_note_id,
                    COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, 0)
               FROM note_links;
         DROP TABLE note_links;
         ALTER TABLE note_links_nuevo RENAME TO note_links;",
    )?;
    Ok(())
}

fn reconstruir_cola(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE sync_queue_nuevo (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
             table_name TEXT NOT NULL CHECK(table_name IN ('notes', 'note_links')),
             record_id TEXT NOT NULL,
             payload TEXT,
             status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'failed')),
             attempts INTEGER NOT NULL DEFAULT 0,
             last_error TEXT,
             created_at INTEGER NOT NULL,
             last_attempt_at INTEGER
         );
         INSERT INTO sync_queue_nuevo (id, operation, table_name, record_id, payload, status, created_at)
             SELECT id, operation, table_name, record_id, payload,
                    CASE WHEN status = 'failed' THEN 'failed' ELSE 'pending' END,
                    COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, 0)
               FROM sync_queue;
         DROP TABLE sync_queue;
         ALTER TABLE sync_queue_nuevo RENAME TO sync_queue;",
    )?;
    Ok(())
}

/// Tipo declarado de una columna ("TEXT", "INTEGER", ...).
fn tipo_columna(conn: &Connection, tabla: &str, columna: &str) -> Option<String> {
    let mut st = conn.prepare(&format!("PRAGMA table_info({tabla})")).ok()?;
    let mut filas = st.query([]).ok()?;
    while let Ok(Some(fila)) = filas.next() {
        let nombre: String = fila.get(1).ok()?;
        let tipo: String = fila.get(2).ok()?;
        if nombre.eq_ignore_ascii_case(columna) {
            return Some(tipo.to_uppercase());
        }
    }
    None
}

/// ¿La columna guarda fechas como texto (esquema antiguo) en vez de milisegundos?
///
/// El esquema antiguo declaraba las columnas como `DATETIME`, que en SQLite no
/// es un tipo real (tiene afinidad NUMERIC), así que no vale mirar solo el
/// tipo declarado: hay que mirar el tipo real de los valores guardados.
fn es_texto(conn: &Connection, tabla: &str, columna: &str) -> bool {
    match tipo_columna(conn, tabla, columna) {
        // INTEGER (o una tabla sin la columna) ya está en el formato bueno.
        Some(tipo) if tipo.contains("INT") => return false,
        None => return false,
        _ => {}
    }

    let sql = format!("SELECT typeof({columna}) FROM {tabla} LIMIT 1");
    match conn.query_row(&sql, [], |r| r.get::<_, String>(0)) {
        Ok(tipo) => tipo.eq_ignore_ascii_case("text"),
        // Tabla vacía: no hay valores que mirar, se reconstruye por si acaso.
        Err(_) => true,
    }
}

fn tiene_columna(conn: &Connection, tabla: &str, columna: &str) -> bool {
    tipo_columna(conn, tabla, columna).is_some()
}
