use convex::{ConvexClient, FunctionResult, Value};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

use super::config::leer_config;

struct Item {
    id: i64,
    kind: String,
    local_id: String,
    payload: serde_json::Value,
}

fn queue_existing(path: &PathBuf) -> Result<(), String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut projects=tx.prepare("SELECT id,name,description,status,created_at,updated_at FROM projects WHERE NOT EXISTS(SELECT 1 FROM cloud_mappings m WHERE m.entity_type='projects' AND m.local_id=projects.id) AND NOT EXISTS(SELECT 1 FROM workbench_sync_queue q WHERE q.entity_type='projects' AND q.local_id=projects.id)").map_err(|e|e.to_string())?;
    let rows=projects.query_map([],|r|Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"description":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"created_at":r.get::<_,i64>(4)?,"updated_at":r.get::<_,i64>(5)?}))).map_err(|e|e.to_string())?;
    let ps = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(projects);
    for p in ps {
        tx.execute("INSERT OR IGNORE INTO workbench_sync_queue(entity_type,local_id,payload,created_at) VALUES('projects',?1,?2,?3)",params![p["id"].as_str(),p.to_string(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64]).map_err(|e|e.to_string())?;
    }
    let mut tasks=tx.prepare("SELECT id,project_id,title,description,status,priority,assignee_agent_id,due_at,created_at,updated_at FROM tasks WHERE NOT EXISTS(SELECT 1 FROM cloud_mappings m WHERE m.entity_type='tasks' AND m.local_id=tasks.id) AND NOT EXISTS(SELECT 1 FROM workbench_sync_queue q WHERE q.entity_type='tasks' AND q.local_id=tasks.id)").map_err(|e|e.to_string())?;
    let rows=tasks.query_map([],|r|Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"project_id":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"description":r.get::<_,String>(3)?,"status":r.get::<_,String>(4)?,"priority":r.get::<_,String>(5)?,"assignee_agent_id":r.get::<_,Option<String>>(6)?,"due_at":r.get::<_,Option<i64>>(7)?,"created_at":r.get::<_,i64>(8)?,"updated_at":r.get::<_,i64>(9)?}))).map_err(|e|e.to_string())?;
    let ts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(tasks);
    for p in ts {
        tx.execute("INSERT OR IGNORE INTO workbench_sync_queue(entity_type,local_id,payload,created_at) VALUES('tasks',?1,?2,?3)",params![p["id"].as_str(),p.to_string(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64]).map_err(|e|e.to_string())?;
    }
    let mut comments=tx.prepare("SELECT c.id,c.task_id,c.comment_type,c.content,c.created_at FROM task_comments c WHERE c.actor_type='human' AND NOT EXISTS(SELECT 1 FROM cloud_mappings m WHERE m.entity_type='task_comments' AND m.local_id=c.id) AND NOT EXISTS(SELECT 1 FROM workbench_sync_queue q WHERE q.entity_type='task_comments' AND q.local_id=c.id)").map_err(|e|e.to_string())?;
    let rows=comments.query_map([],|r|Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"task_id":r.get::<_,String>(1)?,"comment_type":r.get::<_,String>(2)?,"content":r.get::<_,String>(3)?,"created_at":r.get::<_,i64>(4)?}))).map_err(|e|e.to_string())?;
    let cs = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(comments);
    for p in cs {
        tx.execute("INSERT OR IGNORE INTO workbench_sync_queue(entity_type,local_id,payload,created_at) VALUES('task_comments',?1,?2,?3)",params![p["id"].as_str(),p.to_string(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn items(path: &PathBuf) -> Result<Vec<Item>, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let mut stmt = db.prepare("SELECT id, entity_type, local_id, payload FROM workbench_sync_queue WHERE status='pending' ORDER BY CASE entity_type WHEN 'projects' THEN 0 WHEN 'tasks' THEN 1 ELSE 2 END, id LIMIT 100").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        let (id, kind, local_id, p) = r.map_err(|e| e.to_string())?;
        Ok(Item {
            id,
            kind,
            local_id,
            payload: serde_json::from_str(&p).map_err(|e| e.to_string())?,
        })
    })
    .collect()
}
fn val(s: Option<&str>) -> Value {
    s.map(Value::from).unwrap_or(Value::Null)
}
fn num(n: Option<i64>) -> Value {
    n.map(|value| Value::Float64(value as f64)).unwrap_or(Value::Null)
}
fn arg(args: &mut BTreeMap<String, Value>, key: &str, value: Value) {
    args.insert(key.into(), value);
}
fn text_field(fields: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    match fields.get(key) { Some(Value::String(value)) => Some(value.clone()), _ => None }
}
fn number_field(fields: &BTreeMap<String, Value>, key: &str) -> Option<i64> {
    match fields.get(key) { Some(Value::Int64(value)) => Some(*value), Some(Value::Float64(value)) => Some(*value as i64), _ => None }
}
fn cloud_id(db: &Connection, kind: &str, local: &str) -> Result<Option<String>, String> {
    db.query_row(
        "SELECT cloud_id FROM cloud_mappings WHERE entity_type=?1 AND local_id=?2",
        params![kind, local],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}
fn save_mapping(db: &Connection, kind: &str, local: &str, cloud: &str) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    db.execute("INSERT INTO cloud_mappings(entity_type,local_id,cloud_id,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(entity_type,local_id) DO UPDATE SET cloud_id=excluded.cloud_id,updated_at=excluded.updated_at",params![kind,local,cloud,now]).map_err(|e|e.to_string())?;
    Ok(())
}

async fn sync_project_links(client: &mut ConvexClient, db_path: &PathBuf, token: &str) -> Result<u32, String> {
    let mapped = {
        let db = Connection::open(db_path).map_err(|e|e.to_string())?;
        let links = {
            let mut stmt = db.prepare("SELECT id,source_project_id,target_project_id,relation_type,description FROM project_links WHERE NOT EXISTS(SELECT 1 FROM cloud_mappings m WHERE m.entity_type='project_links' AND m.local_id=project_links.id)").map_err(|e|e.to_string())?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).map_err(|e|e.to_string())?;
            rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
        };
        let mut mapped = Vec::with_capacity(links.len());
        for (local_id, source_local, target_local, relation_type, description) in links {
            let source = cloud_id(&db, "projects", &source_local)?.ok_or("Sincroniza primero el proyecto origen.")?;
            let target = cloud_id(&db, "projects", &target_local)?.ok_or("Sincroniza primero el proyecto destino.")?;
            mapped.push((local_id, source, target, relation_type, description));
        }
        mapped
    };
    let mut synced = 0;
    for (local_id, source, target, relation_type, description) in mapped {
        let mut args = BTreeMap::new();
        arg(&mut args, "token", Value::from(token));
        arg(&mut args, "clientId", Value::from(local_id.clone()));
        arg(&mut args, "sourceProjectId", Value::from(source));
        arg(&mut args, "targetProjectId", Value::from(target));
        arg(&mut args, "relationType", Value::from(relation_type));
        arg(&mut args, "description", Value::from(description));
        match client.mutation("projectLinks:crear", args).await.map_err(|e|e.to_string())? {
            FunctionResult::Value(Value::Object(object)) => {
                let id = match object.get("id") { Some(Value::String(id)) => id.clone(), _ => return Err("Convex no devolvió el id de la relación.".into()) };
                let db = Connection::open(db_path).map_err(|e|e.to_string())?;
                save_mapping(&db, "project_links", &local_id, &id)?;
                drop(db);
                synced += 1;
            }
            FunctionResult::ErrorMessage(e) => return Err(e),
            FunctionResult::ConvexError(e) => return Err(e.message),
            _ => return Err("Convex devolvió una respuesta inesperada al guardar relaciones.".into()),
        }
    }
    Ok(synced)
}

async fn pull_cloud_projects(client: &mut ConvexClient, db_path: &PathBuf, token: &str) -> Result<(), String> {
    let mut args = BTreeMap::new();
    arg(&mut args, "token", Value::from(token));
    let result = client.query("workbench:proyectos", args).await.map_err(|e|e.to_string())?;
    let value = match result { FunctionResult::Value(value) => value, FunctionResult::ErrorMessage(e) => return Err(e), FunctionResult::ConvexError(e) => return Err(e.message) };
    let Value::Array(rows) = value else { return Err("Convex no devolvió una lista de proyectos.".into()) };
    let mut projects = Vec::new();
    for value in rows {
        let Value::Object(fields) = value else { continue };
        let id = text_field(&fields, "id").ok_or("Proyecto remoto sin id.")?;
        let local_id = text_field(&fields, "clientId").unwrap_or_else(|| id.clone());
        projects.push((local_id, id, text_field(&fields, "name").unwrap_or_default(), text_field(&fields, "description").unwrap_or_default(), text_field(&fields, "status").unwrap_or_else(|| "active".into()), number_field(&fields, "createdAt").unwrap_or_default(), number_field(&fields, "updatedAt").unwrap_or_default()));
    }
    let db = Connection::open(db_path).map_err(|e|e.to_string())?;
    for (local_id, cloud_id_value, name, description, status, created_at, updated_at) in projects {
        let pending: i64 = db.query_row("SELECT count(*) FROM workbench_sync_queue WHERE entity_type='projects' AND local_id=?1 AND status='pending'", [&local_id], |r|r.get(0)).map_err(|e|e.to_string())?;
        if pending == 0 {
            db.execute("INSERT INTO projects(id,name,description,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at WHERE excluded.updated_at>projects.updated_at", params![local_id,name,description,status,created_at,updated_at]).map_err(|e|e.to_string())?;
        }
        save_mapping(&db, "projects", &local_id, &cloud_id_value)?;
    }
    Ok(())
}

async fn pull_cloud_project_links(client: &mut ConvexClient, db_path: &PathBuf, token: &str) -> Result<(), String> {
    let mut args = BTreeMap::new();
    arg(&mut args, "token", Value::from(token));
    let result = client.query("projectLinks:listar", args).await.map_err(|e|e.to_string())?;
    let value = match result { FunctionResult::Value(value) => value, FunctionResult::ErrorMessage(e) => return Err(e), FunctionResult::ConvexError(e) => return Err(e.message) };
    let Value::Array(rows) = value else { return Err("Convex no devolvió una lista de relaciones.".into()) };
    let mut links = Vec::new();
    for value in rows {
        let Value::Object(fields) = value else { continue };
        links.push((text_field(&fields,"id").ok_or("Relación remota sin id.")?,text_field(&fields,"clientId"),text_field(&fields,"sourceProjectId").ok_or("Relación sin proyecto origen.")?,text_field(&fields,"targetProjectId").ok_or("Relación sin proyecto destino.")?,text_field(&fields,"relationType").unwrap_or_else(||"related_to".into()),text_field(&fields,"description").unwrap_or_default(),number_field(&fields,"createdAt").unwrap_or_default()));
    }
    let db = Connection::open(db_path).map_err(|e|e.to_string())?;
    for (cloud_link_id, client_id, source_cloud, target_cloud, relation_type, description, created_at) in links {
        let project_local = |cloud: &str| -> Result<Option<String>,String> { db.query_row("SELECT local_id FROM cloud_mappings WHERE entity_type='projects' AND cloud_id=?1",[cloud],|r|r.get(0)).optional().map_err(|e|e.to_string()) };
        let (Some(source), Some(target)) = (project_local(&source_cloud)?, project_local(&target_cloud)?) else { continue };
        let local_id = client_id.unwrap_or_else(||cloud_link_id.clone());
        db.execute("INSERT INTO project_links(id,source_project_id,target_project_id,relation_type,description,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(source_project_id,target_project_id) DO UPDATE SET relation_type=excluded.relation_type,description=excluded.description",params![local_id,source,target,relation_type,description,created_at]).map_err(|e|e.to_string())?;
        save_mapping(&db,"project_links",&local_id,&cloud_link_id)?;
    }
    Ok(())
}

async fn send(
    client: &mut ConvexClient,
    db_path: &PathBuf,
    item: &Item,
    token: &str,
) -> Result<String, String> {
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    let p = &item.payload;
    let mut a = BTreeMap::new();
    arg(&mut a, "token", Value::from(token));
    arg(&mut a, "clientId", Value::from(item.local_id.clone()));
    let (function, kind) = match item.kind.as_str() {
        "projects" => {
            for (k, v) in [
                ("name", val(p["name"].as_str())),
                ("description", val(p["description"].as_str())),
                ("status", val(p["status"].as_str())),
                ("createdAt", num(p["created_at"].as_i64())),
                ("updatedAt", num(p["updated_at"].as_i64())),
            ] {
                arg(&mut a, k, v);
            }
            ("sync:proyecto", "projects")
        }
        "tasks" => {
            let project = cloud_id(
                &db,
                "projects",
                p["project_id"].as_str().ok_or("Falta project_id")?,
            )?
            .ok_or("El proyecto aún no está sincronizado")?;
            arg(&mut a, "projectId", Value::from(project));
            if let Some(id) = cloud_id(&db, "tasks", &item.local_id)? {
                arg(&mut a, "taskId", Value::from(id));
            }
            for (k, v) in [
                ("title", val(p["title"].as_str())),
                ("description", val(p["description"].as_str())),
                ("status", val(p["status"].as_str())),
                ("priority", val(p["priority"].as_str())),
                ("dueAt", num(p["due_at"].as_i64())),
                ("assigneeAgentId", Value::Null),
                ("createdAt", num(p["created_at"].as_i64())),
                ("updatedAt", num(p["updated_at"].as_i64())),
            ] {
                arg(&mut a, k, v);
            }
            ("sync:tarea", "tasks")
        }
        "task_comments" => {
            let task = cloud_id(&db, "tasks", p["task_id"].as_str().ok_or("Falta task_id")?)?
                .ok_or("La tarea aún no está sincronizada")?;
            arg(&mut a, "taskId", Value::from(task));
            arg(&mut a, "kind", val(p["comment_type"].as_str()));
            arg(&mut a, "content", val(p["content"].as_str()));
            arg(&mut a, "createdAt", num(p["created_at"].as_i64()));
            ("sync:comentario", "task_comments")
        }
        _ => return Err("Tipo de registro desconocido".into()),
    };
    match client
        .mutation(function, a)
        .await
        .map_err(|e| e.to_string())?
    {
        FunctionResult::Value(Value::Object(o)) => {
            let id = match o.get("id") {
                Some(Value::String(s)) => s.clone(),
                _ => return Err("Convex no devolvió un id".into()),
            };
            save_mapping(&db, kind, &item.local_id, &id)?;
            Ok(id)
        }
        FunctionResult::ErrorMessage(e) => Err(e),
        FunctionResult::ConvexError(e) => Err(e.message),
        _ => Err("Respuesta inesperada de Convex".into()),
    }
}

#[tauri::command]
pub async fn sync_workbench_now(app: AppHandle) -> Result<u32, String> {
    let config =
        leer_config().ok_or("Configura MITPAD_CONVEX_URL y MITPAD_TOKEN para sincronizar.")?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mitpad_local.db");
    queue_existing(&path)?;
    let pending = items(&path)?;
    let mut client = ConvexClient::new(&config.url)
        .await
        .map_err(|e| e.to_string())?;
    let mut done = 0;
    for item in pending {
        match send(&mut client, &path, &item, &config.token).await {
            Ok(_) => {
                let db = Connection::open(&path).map_err(|e| e.to_string())?;
                db.execute("DELETE FROM workbench_sync_queue WHERE id=?1", [item.id])
                    .map_err(|e| e.to_string())?;
                done += 1;
            }
            Err(error) => {
                let db = Connection::open(&path).map_err(|e| e.to_string())?;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                db.execute("UPDATE workbench_sync_queue SET attempts=attempts+1,last_attempt_at=?1,last_error=?2,status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END WHERE id=?3",params![now,error,item.id]).map_err(|e|e.to_string())?;
                if done == 0 {
                    return Err(error);
                }
                break;
            }
        }
    }
    pull_cloud_projects(&mut client, &path, &config.token).await?;
    done += sync_project_links(&mut client, &path, &config.token).await?;
    pull_cloud_project_links(&mut client, &path, &config.token).await?;
    if done > 0 {
        let db = Connection::open(&path).map_err(|e| e.to_string())?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        db.execute("INSERT INTO app_state(key,value) VALUES('last_sync_at',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[now.to_string()]).map_err(|e|e.to_string())?;
    }
    Ok(done)
}

#[tauri::command]
pub async fn list_project_knowledge(app: AppHandle) -> Result<Vec<crate::db::workbench::ProjectKnowledge>, String> {
    let config = leer_config().ok_or("Configura MITPAD_CONVEX_URL y MITPAD_TOKEN para consultar el conocimiento.")?;
    let mut client = ConvexClient::new(&config.url).await.map_err(|e| e.to_string())?;
    let mut args = BTreeMap::new();
    arg(&mut args, "token", Value::from(config.token));
    let result = client.query("knowledge:listar", args).await.map_err(|e| e.to_string())?;
    let values = match result {
        FunctionResult::Value(Value::Array(rows)) => rows,
        FunctionResult::ErrorMessage(error) => return Err(error),
        FunctionResult::ConvexError(error) => return Err(error.message),
        _ => return Err("Convex devolvió una lista de conocimiento inesperada.".into()),
    };
    let db_path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("mitpad_local.db");
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut project_ids = BTreeMap::new();
    let mut stmt = db.prepare("SELECT cloud_id,local_id FROM cloud_mappings WHERE entity_type='projects'").map_err(|e| e.to_string())?;
    let mappings = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|e| e.to_string())?;
    for mapping in mappings { let (cloud, local) = mapping.map_err(|e| e.to_string())?; project_ids.insert(cloud, local); }
    let mut records = Vec::new();
    for value in values {
        let Value::Object(fields) = value else { continue };
        let Some(cloud_project_id) = text_field(&fields, "projectId") else { continue };
        let Some(project_id) = project_ids.get(&cloud_project_id).cloned() else { continue };
        let tags = match fields.get("tags") {
            Some(Value::Array(values)) => values.iter().filter_map(|value| match value { Value::String(tag) => Some(tag.clone()), _ => None }).collect(),
            _ => Vec::new(),
        };
        records.push(crate::db::workbench::ProjectKnowledge {
            id: text_field(&fields, "id").unwrap_or_default(), project_id,
            kind: text_field(&fields, "kind").unwrap_or_else(|| "capability".into()),
            title: text_field(&fields, "title").unwrap_or_default(),
            summary: text_field(&fields, "summary").unwrap_or_default(),
            source: text_field(&fields, "source").unwrap_or_default(), tags,
            updated_at: number_field(&fields, "updatedAt").unwrap_or_default(),
        });
    }
    Ok(records)
}

#[tauri::command]
pub async fn delete_project_link(app: AppHandle, id: String) -> Result<(), String> {
    let path = app.path().app_data_dir().map_err(|e|e.to_string())?.join("mitpad_local.db");
    let cloud_id_value = {
        let db = Connection::open(&path).map_err(|e|e.to_string())?;
        db.query_row("SELECT cloud_id FROM cloud_mappings WHERE entity_type='project_links' AND local_id=?1", [&id], |r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?
    };
    if let Some(cloud_id_value) = cloud_id_value {
        let config = leer_config().ok_or("Configura Convex antes de quitar una relación sincronizada.")?;
        let mut client = ConvexClient::new(&config.url).await.map_err(|e|e.to_string())?;
        let mut args = BTreeMap::new();
        arg(&mut args,"token",Value::from(config.token));
        arg(&mut args,"id",Value::from(cloud_id_value));
        match client.mutation("projectLinks:borrar",args).await.map_err(|e|e.to_string())? {
            FunctionResult::Value(_) => {},
            FunctionResult::ErrorMessage(e) => return Err(e),
            FunctionResult::ConvexError(e) => return Err(e.message),
        }
    }
    let db = Connection::open(&path).map_err(|e|e.to_string())?;
    db.execute("DELETE FROM project_links WHERE id=?1", [&id]).map_err(|e|e.to_string())?;
    db.execute("DELETE FROM cloud_mappings WHERE entity_type='project_links' AND local_id=?1", [&id]).map_err(|e|e.to_string())?;
    Ok(())
}
