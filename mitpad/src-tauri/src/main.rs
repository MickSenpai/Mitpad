// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod sync; 

use db::queries::DbState;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle();
            
            // 1. Inicializamos SQLite
            let conn = db::init_db(app_handle)
                .expect("Fallo crítico al inicializar SQLite local");
            
            app.manage(DbState(std::sync::Mutex::new(conn)));
            
            // 2. Extraemos la ruta exacta de la base de datos para dársela al Worker
            let db_path = app_handle.path().app_data_dir().unwrap().join("mitpad_local.db");
            
            // 3. Encendemos el Worker pasándole la ruta
            sync::worker::start_background_worker(db_path);
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::queries::create_note,
            db::queries::update_note,
            db::queries::delete_note
        ])
        .run(tauri::generate_context!())
        .expect("Error al ejecutar Mitpad");
}