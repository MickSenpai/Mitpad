use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use super::{ahora_ms, queries::DbState};

const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: i64 = 50 * 1024 * 1024;
const IMAGE_TYPES: &[&str] = &["image/jpeg", "image/png", "image/webp", "image/gif"];

#[derive(Debug, Clone, Serialize)]
pub struct NoteImage {
    pub id: String,
    pub note_id: String,
    pub filename: String,
    pub content_type: String,
    pub size: usize,
    pub cloud_image_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectImage {
    pub id: String,
    pub project_id: String,
    pub filename: String,
    pub content_type: String,
    pub size: usize,
    pub cloud_image_id: Option<String>,
    pub created_at: i64,
}

#[tauri::command]
pub fn save_note_image(
    state: State<'_, DbState>,
    note_id: String,
    filename: String,
    content_type: String,
    content: Vec<u8>,
) -> Result<NoteImage, String> {
    if content.len() > MAX_IMAGE_BYTES {
        return Err("La imagen supera el límite de 10 MB.".into());
    }
    if !IMAGE_TYPES.contains(&content_type.as_str()) {
        return Err("Formato no admitido; usa JPEG, PNG, WebP o GIF.".into());
    }
    if filename.trim().is_empty() || filename.len() > 255 {
        return Err("Nombre de archivo inválido.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE id = ?1)",
            [&note_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Guarda la nota antes de adjuntar imágenes.".into());
    }
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM note_images WHERE note_id = ?1",
            [&note_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count >= 200 {
        return Err("Esta nota ya tiene el máximo de 200 imágenes.".into());
    }
    let total: i64 = conn
        .query_row(
            "SELECT coalesce(sum(length(content)), 0) FROM note_images WHERE note_id = ?1",
            [&note_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if total + content.len() as i64 > MAX_TOTAL_BYTES {
        return Err("Los adjuntos de la nota no pueden superar 50 MB.".into());
    }
    let image = NoteImage {
        id: Uuid::new_v4().to_string(),
        note_id,
        filename: filename.trim().to_owned(),
        content_type,
        size: content.len(),
        cloud_image_id: None,
        created_at: ahora_ms(),
    };
    conn.execute("INSERT INTO note_images (id, note_id, filename, content_type, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![image.id, image.note_id, image.filename, image.content_type, content, image.created_at]).map_err(|e| e.to_string())?;
    Ok(image)
}

#[tauri::command]
pub fn list_note_images(
    state: State<'_, DbState>,
    note_id: String,
) -> Result<Vec<NoteImage>, String> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let mut stmt = conn.prepare("SELECT id, note_id, filename, content_type, length(content), cloud_image_id, created_at FROM note_images WHERE note_id = ?1 ORDER BY created_at").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([note_id], |r| {
            Ok(NoteImage {
                id: r.get(0)?,
                note_id: r.get(1)?,
                filename: r.get(2)?,
                content_type: r.get(3)?,
                size: r.get::<_, i64>(4)? as usize,
                cloud_image_id: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_note_image(state: State<'_, DbState>, id: String) -> Result<Vec<u8>, String> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    conn.query_row("SELECT content FROM note_images WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "No se encontró la imagen local.".into())
}

#[tauri::command]
pub fn delete_note_image(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    conn.execute("DELETE FROM note_images WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_project_image(
    state: State<'_, DbState>,
    project_id: String,
    filename: String,
    content_type: String,
    content: Vec<u8>,
) -> Result<ProjectImage, String> {
    if content.len() > MAX_IMAGE_BYTES {
        return Err("La imagen supera el límite de 10 MB.".into());
    }
    if !IMAGE_TYPES.contains(&content_type.as_str()) {
        return Err("Formato no admitido; usa JPEG, PNG, WebP o GIF.".into());
    }
    if filename.trim().is_empty() || filename.len() > 255 {
        return Err("Nombre de archivo inválido.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1 AND status = 'active')",
            [&project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Selecciona un proyecto activo antes de subir imágenes.".into());
    }
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM project_images WHERE project_id = ?1",
            [&project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count >= 200 {
        return Err("Este proyecto ya tiene el máximo de 200 imágenes.".into());
    }
    let total: i64 = conn
        .query_row(
            "SELECT coalesce(sum(length(content)), 0) FROM project_images WHERE project_id = ?1",
            [&project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if total + content.len() as i64 > MAX_TOTAL_BYTES {
        return Err("Las imágenes del proyecto no pueden superar 50 MB.".into());
    }
    let image = ProjectImage {
        id: Uuid::new_v4().to_string(),
        project_id,
        filename: filename.trim().to_owned(),
        content_type,
        size: content.len(),
        cloud_image_id: None,
        created_at: ahora_ms(),
    };
    conn.execute(
        "INSERT INTO project_images (id, project_id, filename, content_type, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![image.id, image.project_id, image.filename, image.content_type, content, image.created_at],
    ).map_err(|e| e.to_string())?;
    Ok(image)
}

#[tauri::command]
pub fn list_project_images(
    state: State<'_, DbState>,
    project_id: String,
) -> Result<Vec<ProjectImage>, String> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, project_id, filename, content_type, length(content), cloud_image_id, created_at FROM project_images WHERE project_id = ?1 ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project_id], |r| {
            Ok(ProjectImage {
                id: r.get(0)?,
                project_id: r.get(1)?,
                filename: r.get(2)?,
                content_type: r.get(3)?,
                size: r.get::<_, i64>(4)? as usize,
                cloud_image_id: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_project_image(state: State<'_, DbState>, id: String) -> Result<Vec<u8>, String> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    conn.query_row(
        "SELECT content FROM project_images WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "No se encontró la imagen del proyecto.".into())
}

#[tauri::command]
pub fn delete_project_image(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    conn.execute("DELETE FROM project_images WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
