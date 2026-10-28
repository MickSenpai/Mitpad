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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::queries::create_note,
            db::queries::update_note,
            db::queries::mark_note_attended,
            db::queries::list_notes,
            db::queries::sync_status,
            db::queries::retry_failed,
            sync::workbench::sync_workbench_now,
            sync::workbench::list_project_knowledge,
            sync::workbench::delete_project_link,
            db::images::save_note_image,
            db::images::list_note_images,
            db::images::read_note_image,
            db::images::delete_note_image,
            db::images::save_project_image,
            db::images::list_project_images,
            db::images::read_project_image,
            db::images::delete_project_image,
            db::workbench::create_project,
            db::workbench::list_projects,
            db::workbench::list_project_links,
            db::workbench::create_project_link,
            db::workbench::create_task,
            db::workbench::list_tasks,
            db::workbench::update_task,
            db::workbench::create_task_comment,
            db::workbench::list_task_comments,
            db::workbench::list_activity,
            db::workbench::create_local_agent,
            db::workbench::update_local_agent,
            db::workbench::delete_local_agent,
            db::workbench::list_agents,
        ])
        .run(tauri::generate_context!())
        .expect("Error al ejecutar Mitpad");
}
