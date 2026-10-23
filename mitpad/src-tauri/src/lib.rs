// src-tauri/src/lib.rs
//! Mitpad: app de notas offline-first.
//!
//! `main.rs` solo llama a `run()`. Aquí se registran los comandos y se
//! prepara la base de datos local y el worker de sincronización, para que el
//! punto de entrada de móvil (`#[tauri::mobile_entry_point]`) tenga lo mismo
//! que el de escritorio.
mod db;
mod sync;

use db::queries::DbState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle();

            // 1. Inicializamos SQLite
            let conn = db::init_db(app_handle).expect("Fallo crítico al inicializar SQLite local");

            app.manage(DbState(std::sync::Mutex::new(conn)));

            // 2. Extraemos la ruta exacta de la base de datos para dársela al Worker
            let db_path = app_handle
                .path()
                .app_data_dir()
                .expect("No se pudo resolver el directorio de datos de la app")
                .join("mitpad_local.db");

            // 3. Encendemos el Worker pasándole la ruta
            sync::worker::start_background_worker(db_path);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::queries::create_note,
            db::queries::update_note,
            db::queries::delete_note,
            db::queries::list_notes,
            db::queries::sync_status,
            db::queries::retry_failed,
            sync::pull::pull_notes,
        ])
        .run(tauri::generate_context!())
        .expect("Error al ejecutar Mitpad");
}
