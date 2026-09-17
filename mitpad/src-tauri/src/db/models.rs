use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub user_id: String,
    pub title: Option<String>, // Ahora el título es opcional (coincide con Postgres)
    pub content: String,       // Ahora el contenido es obligatorio (coincide con Postgres)
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncItem {
    pub id: i64,
    pub operation: String,
    pub table_name: String,
    pub record_id: String,
    pub payload: Option<String>,
    pub status: String,
}