use serde::{Deserialize, Serialize};

/// Una nota tal y como viaja entre Rust y el frontend.
/// Las fechas son milisegundos desde 1970 (el mismo formato que usa Convex).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub user_id: String,
    pub title: Option<String>,
    pub content: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// `updated_at` que la nube confirmó. `None` = todavía no se ha subido.
    pub synced_at: Option<i64>,
}

/// Estado de la cola de sincronización (lo que ve el frontend).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatus {
    /// Operaciones esperando a subirse.
    pub pending: i64,
    /// Operaciones que fallaron tantas veces que quedaron apartadas.
    pub failed: i64,
    /// Último error guardado (si lo hay).
    pub last_error: Option<String>,
    /// Última subida correcta (ms desde 1970).
    pub last_sync_at: Option<i64>,
    /// Si la app tiene URL y token para hablar con la nube.
    pub configured: bool,
}
