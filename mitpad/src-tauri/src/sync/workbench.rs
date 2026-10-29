use convex::{ConvexClient, FunctionResult, Value};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

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
    n.map(|value| Value::Float64(value as f64))
        .unwrap_or(Value::Null)
}
fn arg(args: &mut BTreeMap<String, Value>, key: &str, value: Value) {
    args.insert(key.into(), value);
}
fn text_field(fields: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    match fields.get(key) {
        Some(Value::String(value)) => Some(value.clone()),
        _ => None,
    }
}
fn number_field(fields: &BTreeMap<String, Value>, key: &str) -> Option<i64> {
    match fields.get(key) {
        Some(Value::Int64(value)) => Some(*value),
        Some(Value::Float64(value)) => Some(*value as i64),
        _ => None,
    }
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

async fn sync_project_links(client: &mut ConvexClient, db_path: &PathBuf) -> Result<u32, String> {
    let mapped = {
        let db = Connection::open(db_path).map_err(|e| e.to_string())?;
        let links = {
            let mut stmt = db.prepare("SELECT id,source_project_id,target_project_id,relation_type,description,created_at FROM project_links WHERE NOT EXISTS(SELECT 1 FROM cloud_mappings m WHERE m.entity_type='project_links' AND m.local_id=project_links.id)").map_err(|e|e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, i64>(5)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut mapped = Vec::with_capacity(links.len());
        for (local_id, source_local, target_local, relation_type, description, created_at) in links
        {
            let source = cloud_id(&db, "projects", &source_local)?
                .ok_or("Sincroniza primero el proyecto origen.")?;
            let target = cloud_id(&db, "projects", &target_local)?
                .ok_or("Sincroniza primero el proyecto destino.")?;
            mapped.push((
                local_id,
                source,
                target,
                relation_type,
                description,
                created_at,
            ));
        }
        mapped
    };
    let mut synced = 0;
    for (local_id, source, target, relation_type, description, created_at) in mapped {
        let mut args = BTreeMap::new();
        arg(&mut args, "clientId", Value::from(local_id.clone()));
        arg(&mut args, "sourceProjectId", Value::from(source));
        arg(&mut args, "targetProjectId", Value::from(target));
        arg(&mut args, "relationType", Value::from(relation_type));
        arg(&mut args, "description", Value::from(description));
        arg(&mut args, "createdAt", Value::Float64(created_at as f64));
        match client
            .mutation("desktopSync:upsertLink", args)
            .await
            .map_err(|e| e.to_string())?
        {
            FunctionResult::Value(Value::String(id)) => {
                let db = Connection::open(db_path).map_err(|e| e.to_string())?;
                save_mapping(&db, "project_links", &local_id, &id)?;
                drop(db);
                synced += 1;
            }
            FunctionResult::ErrorMessage(e) => return Err(e),
            FunctionResult::ConvexError(e) => return Err(e.message),
            _ => {
                return Err(
                    "Convex devolvió una respuesta inesperada al guardar relaciones.".into(),
                )
            }
        }
    }
    Ok(synced)
}

async fn pull_cloud_projects(
    snapshot: &BTreeMap<String, Value>,
    db_path: &PathBuf,
) -> Result<(), String> {
    let Value::Array(rows) = snapshot.get("projects").cloned().unwrap_or(Value::Null) else {
        return Err("Convex no devolvió proyectos.".into());
    };
    let mut projects = Vec::new();
    for value in rows {
        let Value::Object(fields) = value else {
            continue;
        };
        let id = text_field(&fields, "id").ok_or("Proyecto remoto sin id.")?;
        let local_id = text_field(&fields, "clientId").unwrap_or_else(|| id.clone());
        projects.push((
            local_id,
            id,
            text_field(&fields, "name").unwrap_or_default(),
            text_field(&fields, "description").unwrap_or_default(),
            text_field(&fields, "status").unwrap_or_else(|| "active".into()),
            number_field(&fields, "createdAt").unwrap_or_default(),
            number_field(&fields, "updatedAt").unwrap_or_default(),
        ));
    }
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    for (local_id, cloud_id_value, name, description, status, created_at, updated_at) in projects {
        let mapped_local: Option<String> = db
            .query_row(
                "SELECT local_id FROM cloud_mappings WHERE entity_type='projects' AND cloud_id=?1",
                [&cloud_id_value],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let local_id = mapped_local.unwrap_or(local_id);
        let pending: i64 = db.query_row("SELECT count(*) FROM workbench_sync_queue WHERE entity_type='projects' AND local_id=?1 AND status='pending'", [&local_id], |r|r.get(0)).map_err(|e|e.to_string())?;
        if pending == 0 {
            db.execute("INSERT INTO projects(id,name,description,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at WHERE excluded.updated_at>projects.updated_at", params![local_id,name,description,status,created_at,updated_at]).map_err(|e|e.to_string())?;
        }
        save_mapping(&db, "projects", &local_id, &cloud_id_value)?;
    }
    Ok(())
}

fn map_existing_projects(
    snapshot: &BTreeMap<String, Value>,
    db_path: &PathBuf,
) -> Result<(), String> {
    let Value::Array(remote_projects) = snapshot.get("projects").cloned().unwrap_or(Value::Null)
    else {
        return Err("Convex no devolvió proyectos.".into());
    };
    let mut remote_by_name: BTreeMap<String, Vec<(String, Option<String>)>> = BTreeMap::new();
    for value in remote_projects {
        let Value::Object(fields) = value else {
            continue;
        };
        let Some(id) = text_field(&fields, "id") else {
            continue;
        };
        let Some(name) = text_field(&fields, "name") else {
            continue;
        };
        remote_by_name
            .entry(name.trim().to_lowercase())
            .or_default()
            .push((id, text_field(&fields, "clientId")));
    }
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    let local_projects = {
        let mut stmt = db.prepare("SELECT p.id,p.name FROM projects p WHERE NOT EXISTS(SELECT 1 FROM cloud_mappings m WHERE m.entity_type='projects' AND m.local_id=p.id)").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (local_id, name) in local_projects {
        let Some(candidates) = remote_by_name.get(&name.trim().to_lowercase()) else {
            continue;
        };
        let exact_client_id = candidates
            .iter()
            .find(|(_, client_id)| client_id.as_deref() == Some(local_id.as_str()));
        let seeded_repo = if candidates.len() == 1 {
            candidates.first().filter(|(_, client_id)| {
                client_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("repo:"))
            })
        } else {
            None
        };
        if let Some((cloud_id_value, _)) = exact_client_id.or(seeded_repo) {
            save_mapping(&db, "projects", &local_id, cloud_id_value)?;
        }
    }
    Ok(())
}

async fn pull_cloud_agents(
    snapshot: &BTreeMap<String, Value>,
    db_path: &PathBuf,
) -> Result<(), String> {
    let Value::Array(rows) = snapshot.get("agents").cloned().unwrap_or(Value::Null) else {
        return Err("Convex no devolvió agentes.".into());
    };
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    for value in rows {
        let Value::Object(fields) = value else {
            continue;
        };
        let id = text_field(&fields, "id").ok_or("Agente remoto sin id.")?;
        let status = if matches!(fields.get("active"), Some(Value::Boolean(false))) {
            "disabled"
        } else {
            "active"
        };
        db.execute("INSERT INTO agents(id,name,model,provider,client_type,status,created_at,last_seen_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET name=excluded.name,model=excluded.model,provider=excluded.provider,client_type=excluded.client_type,status=excluded.status,last_seen_at=excluded.last_seen_at", params![id, text_field(&fields,"name").unwrap_or_default(), text_field(&fields,"model"), text_field(&fields,"modelProvider"), text_field(&fields,"clientType"), status, number_field(&fields,"createdAt").unwrap_or_default(), number_field(&fields,"lastSeenAt")]).map_err(|e| e.to_string())?;
        save_mapping(&db, "agents", &id, &id)?;
    }
    Ok(())
}

async fn pull_cloud_project_links(
    snapshot: &BTreeMap<String, Value>,
    db_path: &PathBuf,
) -> Result<(), String> {
    let Value::Array(rows) = snapshot.get("links").cloned().unwrap_or(Value::Null) else {
        return Err("Convex no devolvió relaciones.".into());
    };
    let mut links = Vec::new();
    for value in rows {
        let Value::Object(fields) = value else {
            continue;
        };
        links.push((
            text_field(&fields, "id").ok_or("Relación remota sin id.")?,
            text_field(&fields, "clientId"),
            text_field(&fields, "sourceProjectId").ok_or("Relación sin proyecto origen.")?,
            text_field(&fields, "targetProjectId").ok_or("Relación sin proyecto destino.")?,
            text_field(&fields, "relationType").unwrap_or_else(|| "related_to".into()),
            text_field(&fields, "description").unwrap_or_default(),
            number_field(&fields, "createdAt").unwrap_or_default(),
        ));
    }
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    for (
        cloud_link_id,
        client_id,
        source_cloud,
        target_cloud,
        relation_type,
        description,
        created_at,
    ) in links
    {
        let project_local = |cloud: &str| -> Result<Option<String>, String> {
            db.query_row(
                "SELECT local_id FROM cloud_mappings WHERE entity_type='projects' AND cloud_id=?1",
                [cloud],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
        };
        let (Some(source), Some(target)) =
            (project_local(&source_cloud)?, project_local(&target_cloud)?)
        else {
            continue;
        };
        let local_id = client_id.unwrap_or_else(|| cloud_link_id.clone());
        db.execute("INSERT INTO project_links(id,source_project_id,target_project_id,relation_type,description,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(source_project_id,target_project_id) DO UPDATE SET relation_type=excluded.relation_type,description=excluded.description",params![local_id,source,target,relation_type,description,created_at]).map_err(|e|e.to_string())?;
        save_mapping(&db, "project_links", &local_id, &cloud_link_id)?;
    }
    Ok(())
}

async fn pull_cloud_tasks(
    snapshot: &BTreeMap<String, Value>,
    db_path: &PathBuf,
) -> Result<(), String> {
    let Value::Array(rows) = snapshot.get("tasks").cloned().unwrap_or(Value::Null) else {
        return Err("Convex no devolvió tareas.".into());
    };
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    for value in rows {
        let Value::Object(fields) = value else {
            continue;
        };
        let cloud_id_value = text_field(&fields, "id").ok_or("Tarea remota sin id.")?;
        let project_cloud = text_field(&fields, "projectId").ok_or("Tarea remota sin proyecto.")?;
        let project_local: Option<String> = db
            .query_row(
                "SELECT local_id FROM cloud_mappings WHERE entity_type='projects' AND cloud_id=?1",
                [&project_cloud],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(project_id) = project_local else {
            continue;
        };
        let assignee_cloud = text_field(&fields, "assigneeAgentId");
        let assignee_local: Option<String> = if let Some(agent_id) = assignee_cloud.as_deref() {
            db.query_row(
                "SELECT local_id FROM cloud_mappings WHERE entity_type='agents' AND cloud_id=?1",
                [agent_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        } else {
            None
        };
        let local_id = text_field(&fields, "clientId").unwrap_or_else(|| cloud_id_value.clone());
        let pending: i64 = db.query_row("SELECT count(*) FROM workbench_sync_queue WHERE entity_type='tasks' AND local_id=?1 AND status='pending'", [&local_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let title = text_field(&fields, "title").unwrap_or_default();
        let description = text_field(&fields, "description").unwrap_or_default();
        let status = text_field(&fields, "status").unwrap_or_else(|| "todo".into());
        let priority = text_field(&fields, "priority").unwrap_or_else(|| "medium".into());
        let created_at = number_field(&fields, "createdAt").unwrap_or_default();
        let updated_at = number_field(&fields, "updatedAt").unwrap_or_default();
        let due_at = number_field(&fields, "dueAt");
        if pending == 0 {
            db.execute("INSERT INTO tasks(id,project_id,title,description,status,priority,assignee_agent_id,due_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,description=excluded.description,status=excluded.status,priority=excluded.priority,assignee_agent_id=excluded.assignee_agent_id,due_at=excluded.due_at,updated_at=excluded.updated_at WHERE excluded.updated_at>tasks.updated_at", params![local_id, project_id, title, description, status, priority, assignee_local, due_at, created_at, updated_at]).map_err(|e| e.to_string())?;
        }
        save_mapping(&db, "tasks", &local_id, &cloud_id_value)?;
    }
    Ok(())
}

async fn pull_cloud_comments(
    snapshot: &BTreeMap<String, Value>,
    db_path: &PathBuf,
) -> Result<(), String> {
    let Value::Array(rows) = snapshot.get("comments").cloned().unwrap_or(Value::Null) else {
        return Err("Convex no devolvió comentarios.".into());
    };
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    for value in rows {
        let Value::Object(fields) = value else {
            continue;
        };
        let cloud_id_value = text_field(&fields, "id").ok_or("Comentario remoto sin id.")?;
        let task_cloud = text_field(&fields, "taskId").ok_or("Comentario remoto sin tarea.")?;
        let task_local: Option<String> = db
            .query_row(
                "SELECT local_id FROM cloud_mappings WHERE entity_type='tasks' AND cloud_id=?1",
                [&task_cloud],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(task_id) = task_local else { continue };
        let local_id = text_field(&fields, "clientId").unwrap_or_else(|| cloud_id_value.clone());
        let already: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM task_comments WHERE id=?1)",
                [&local_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !already {
            db.execute("INSERT INTO task_comments(id,task_id,actor_type,actor,comment_type,content,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![local_id, task_id, text_field(&fields,"authorType").unwrap_or_else(||"agent".into()), text_field(&fields,"authorId").unwrap_or_default(), text_field(&fields,"kind").unwrap_or_else(||"update".into()), text_field(&fields,"content").unwrap_or_default(), number_field(&fields,"createdAt").unwrap_or_default()]).map_err(|e| e.to_string())?;
        }
        save_mapping(&db, "task_comments", &local_id, &cloud_id_value)?;
    }
    Ok(())
}

async fn sync_note_queue(client: &mut ConvexClient, db_path: &PathBuf) -> Result<u32, String> {
    // Keep rusqlite's non-Send statement and row iterator in a synchronous scope.
    // Tauri requires command futures to be Send across every await point.
    let pending = {
        let db = Connection::open(db_path).map_err(|e| e.to_string())?;
        let mut stmt = db.prepare("SELECT id,operation,record_id,payload FROM sync_queue WHERE table_name='notes' AND status='pending' ORDER BY id LIMIT 100").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut sent = 0;
    for (queue_id, operation, note_id, payload) in pending {
        if operation == "DELETE" {
            let mut args = BTreeMap::new();
            arg(&mut args, "uuid", Value::from(note_id));
            match client.mutation("desktopSync:deleteNote", args).await.map_err(|e| e.to_string())? {
                FunctionResult::Value(_) => {
                    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
                    db.execute("DELETE FROM sync_queue WHERE id=?1", [queue_id]).map_err(|e| e.to_string())?;
                    sent += 1;
                    continue;
                }
                FunctionResult::ErrorMessage(e) => return Err(e),
                FunctionResult::ConvexError(e) => return Err(e.message),
            }
        }
        let payload: serde_json::Value =
            serde_json::from_str(payload.as_deref().ok_or("Nota pendiente sin carga útil.")?)
                .map_err(|e| e.to_string())?;
        let created_at: i64 = Connection::open(db_path)
            .map_err(|e| e.to_string())?
            .query_row(
                "SELECT created_at FROM notes WHERE id=?1",
                [&note_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut args = BTreeMap::new();
        arg(&mut args, "uuid", Value::from(note_id.clone()));
        arg(
            &mut args,
            "title",
            payload["title"]
                .as_str()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        arg(
            &mut args,
            "content",
            Value::from(payload["content"].as_str().unwrap_or_default()),
        );
        arg(
            &mut args,
            "status",
            Value::from(payload["status"].as_str().unwrap_or("open")),
        );
        arg(&mut args, "createdAt", Value::Float64(created_at as f64));
        arg(&mut args, "updatedAt", num(payload["updated_at"].as_i64()));
        match client
            .mutation("desktopSync:upsertNote", args)
            .await
            .map_err(|e| e.to_string())?
        {
            FunctionResult::Value(_) => {
                let db = Connection::open(db_path).map_err(|e| e.to_string())?;
                db.execute(
                    "UPDATE notes SET synced_at=updated_at WHERE id=?1",
                    [&note_id],
                )
                .map_err(|e| e.to_string())?;
                db.execute("DELETE FROM sync_queue WHERE id=?1", [queue_id])
                    .map_err(|e| e.to_string())?;
                sent += 1;
            }
            FunctionResult::ErrorMessage(e) => return Err(e),
            FunctionResult::ConvexError(e) => return Err(e.message),
        }
    }
    Ok(sent)
}

type PendingImage = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    Vec<u8>,
    i64,
);

/// Sube los adjuntos pendientes conservando sus bytes en SQLite para uso offline.
async fn sync_local_images(client: &mut ConvexClient, db_path: &PathBuf) -> Result<u32, String> {
    let pending = {
        let db = Connection::open(db_path).map_err(|e| e.to_string())?;
        let mut images: Vec<PendingImage> = Vec::new();
        {
            let mut stmt = db.prepare("SELECT id,note_id,NULL,filename,content_type,content,created_at FROM note_images WHERE cloud_image_id IS NULL ORDER BY created_at LIMIT 200").map_err(|e|e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        Some(r.get::<_, String>(1)?),
                        None,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Vec<u8>>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            images.extend(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?,
            );
        }
        {
            let mut stmt = db.prepare("SELECT id,NULL,project_id,filename,content_type,content,created_at FROM project_images WHERE cloud_image_id IS NULL ORDER BY created_at LIMIT 200").map_err(|e|e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        None,
                        Some(r.get::<_, String>(2)?),
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Vec<u8>>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            images.extend(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?,
            );
        }
        images
    };
    let http = reqwest::Client::new();
    let mut synced = 0;
    for (local_id, note_id, project_local, filename, content_type, bytes, created_at) in pending {
        let project_id = match project_local.as_deref() {
            Some(local) => Some(
                cloud_id(
                    &Connection::open(db_path).map_err(|e| e.to_string())?,
                    "projects",
                    local,
                )?
                .ok_or("Sincroniza el proyecto antes de subir su imagen.")?,
            ),
            None => None,
        };
        let mut args = BTreeMap::new();
        let upload_url = match client
            .mutation("desktopSync:createImageUploadUrl", args.clone())
            .await
            .map_err(|e| e.to_string())?
        {
            FunctionResult::Value(Value::String(url)) => url,
            FunctionResult::ErrorMessage(e) => return Err(e),
            FunctionResult::ConvexError(e) => return Err(e.message),
            _ => return Err("Convex devolvió una URL de subida inválida.".into()),
        };
        let response = http
            .post(upload_url)
            .header(reqwest::header::CONTENT_TYPE, &content_type)
            .body(bytes.clone())
            .send()
            .await
            .map_err(|e| format!("No se pudo subir {filename}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Convex rechazó {filename}: {e}"))?;
        let uploaded: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Respuesta inválida al subir {filename}: {e}"))?;
        let storage_id = uploaded
            .get("storageId")
            .and_then(|v| v.as_str())
            .ok_or("Convex no devolvió el identificador de almacenamiento.")?;
        arg(&mut args, "localId", Value::from(local_id.clone()));
        arg(
            &mut args,
            "noteId",
            note_id.clone().map(Value::from).unwrap_or(Value::Null),
        );
        arg(
            &mut args,
            "projectId",
            project_id.map(Value::from).unwrap_or(Value::Null),
        );
        arg(&mut args, "storageId", Value::from(storage_id));
        arg(&mut args, "filename", Value::from(filename));
        arg(&mut args, "contentType", Value::from(content_type));
        arg(&mut args, "size", Value::Float64(bytes.len() as f64));
        arg(&mut args, "createdAt", Value::Float64(created_at as f64));
        match client
            .mutation("desktopSync:registerImage", args)
            .await
            .map_err(|e| e.to_string())?
        {
            FunctionResult::Value(Value::String(cloud_id_value)) => {
                let db = Connection::open(db_path).map_err(|e| e.to_string())?;
                if note_id.is_some() {
                    db.execute(
                        "UPDATE note_images SET cloud_image_id=?1 WHERE id=?2",
                        params![cloud_id_value, local_id],
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    db.execute(
                        "UPDATE project_images SET cloud_image_id=?1 WHERE id=?2",
                        params![cloud_id_value, local_id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                synced += 1;
            }
            FunctionResult::ErrorMessage(e) => return Err(e),
            FunctionResult::ConvexError(e) => return Err(e.message),
            _ => {
                return Err(
                    "Convex devolvió una respuesta inesperada al registrar la imagen.".into(),
                )
            }
        }
    }
    Ok(synced)
}

/// Descarga adjuntos creados en la web y los deja disponibles offline en SQLite.
async fn pull_cloud_images(
    snapshot: &BTreeMap<String, Value>,
    db_path: &PathBuf,
) -> Result<(), String> {
    let Value::Array(rows) = snapshot.get("images").cloned().unwrap_or(Value::Null) else {
        return Err("Convex no devolvió imágenes.".into());
    };
    let mut images = Vec::new();
    for row in rows {
        let Value::Object(fields) = row else { continue };
        let Some(url) = text_field(&fields, "url") else {
            continue;
        };
        images.push((
            text_field(&fields, "id").ok_or("Imagen remota sin id.")?,
            text_field(&fields, "localId"),
            text_field(&fields, "noteId"),
            text_field(&fields, "projectId"),
            text_field(&fields, "filename").unwrap_or_else(|| "imagen".into()),
            text_field(&fields, "contentType").unwrap_or_else(|| "application/octet-stream".into()),
            number_field(&fields, "createdAt").unwrap_or_default(),
            url,
        ));
    }
    let http = reqwest::Client::new();
    for (remote_id, local_id, note_id, project_cloud, filename, content_type, created_at, url) in
        images
    {
        let exists: bool = Connection::open(db_path).map_err(|e|e.to_string())?.query_row("SELECT EXISTS(SELECT 1 FROM note_images WHERE cloud_image_id=?1 UNION ALL SELECT 1 FROM project_images WHERE cloud_image_id=?1)",[&remote_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if exists {
            continue;
        }
        let response = http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("No se pudo descargar {filename}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Falló la descarga de {filename}: {e}"))?;
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > 10 * 1024 * 1024 {
            continue;
        }
        let db = Connection::open(db_path).map_err(|e| e.to_string())?;
        if let Some(note_id) = note_id {
            let parent_exists: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1)",
                    [&note_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if parent_exists {
                db.execute("INSERT OR IGNORE INTO note_images(id,note_id,filename,content_type,content,cloud_image_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![local_id.unwrap_or_else(||remote_id.clone()),note_id,filename,content_type,bytes.as_ref(),remote_id,created_at]).map_err(|e|e.to_string())?;
            }
        } else if let Some(project_cloud) = project_cloud {
            let project_local: Option<String> = db.query_row("SELECT local_id FROM cloud_mappings WHERE entity_type='projects' AND cloud_id=?1",[&project_cloud],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            if let Some(project_local) = project_local {
                db.execute("INSERT OR IGNORE INTO project_images(id,project_id,filename,content_type,content,cloud_image_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![local_id.unwrap_or_else(||remote_id.clone()),project_local,filename,content_type,bytes.as_ref(),remote_id,created_at]).map_err(|e|e.to_string())?;
            }
        }
    }
    Ok(())
}

async fn pull_cloud_notes(
    snapshot: &BTreeMap<String, Value>,
    db_path: &PathBuf,
) -> Result<(), String> {
    let Value::Array(rows) = snapshot.get("notes").cloned().unwrap_or(Value::Null) else {
        return Err("Convex no devolvió notas.".into());
    };
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    for value in rows {
        let Value::Object(fields) = value else {
            continue;
        };
        let id = text_field(&fields, "uuid").ok_or("Nota remota sin id.")?;
        if number_field(&fields, "deletedAt").is_some() {
            db.execute("DELETE FROM sync_queue WHERE table_name='notes' AND record_id=?1", [&id]).map_err(|e| e.to_string())?;
            db.execute("DELETE FROM notes WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
            continue;
        }
        let updated = number_field(&fields, "updatedAt").unwrap_or_default();
        let current: Option<(i64, Option<i64>)> = db
            .query_row(
                "SELECT updated_at,synced_at FROM notes WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let pending: i64 = db.query_row("SELECT count(*) FROM sync_queue WHERE table_name='notes' AND record_id=?1 AND status='pending'", [&id], |r|r.get(0)).map_err(|e|e.to_string())?;
        if pending > 0 {
            continue;
        }
        let title = text_field(&fields, "title");
        let content = text_field(&fields, "content").unwrap_or_default();
        let status = text_field(&fields, "status").unwrap_or_else(|| "open".into());
        let created = number_field(&fields, "createdAt").unwrap_or_default();
        match current {
            None => {
                db.execute("INSERT INTO notes(id,user_id,title,content,status,created_at,updated_at,synced_at) VALUES(?1,'f7c9a64f-efa2-4f29-8822-b1b6a1c2030c',?2,?3,?4,?5,?6,?6)", params![id,title,content,status,created,updated]).map_err(|e|e.to_string())?;
            }
            Some((local_updated, _)) if updated > local_updated => {
                db.execute("UPDATE notes SET title=?1,content=?2,status=?3,updated_at=?4,synced_at=?4 WHERE id=?5",params![title,content,status,updated,id]).map_err(|e|e.to_string())?;
            }
            _ => {}
        }
    }
    Ok(())
}

async fn send(client: &mut ConvexClient, db_path: &PathBuf, item: &Item) -> Result<String, String> {
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    let p = &item.payload;
    let mut a = BTreeMap::new();
    arg(&mut a, "clientId", Value::from(item.local_id.clone()));
    let (function, kind) = match item.kind.as_str() {
        "projects" => {
            arg(
                &mut a,
                "projectId",
                cloud_id(&db, "projects", &item.local_id)?
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            for (k, v) in [
                ("name", val(p["name"].as_str())),
                ("description", val(p["description"].as_str())),
                ("status", val(p["status"].as_str())),
                ("createdAt", num(p["created_at"].as_i64())),
                ("updatedAt", num(p["updated_at"].as_i64())),
            ] {
                arg(&mut a, k, v);
            }
            ("desktopSync:upsertProject", "projects")
        }
        "tasks" => {
            let project = cloud_id(
                &db,
                "projects",
                p["project_id"].as_str().ok_or("Falta project_id")?,
            )?
            .ok_or("El proyecto aún no está sincronizado")?;
            arg(&mut a, "projectId", Value::from(project));
            arg(
                &mut a,
                "taskId",
                cloud_id(&db, "tasks", &item.local_id)?
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            arg(
                &mut a,
                "assigneeAgentId",
                match p["assignee_agent_id"].as_str() {
                    Some(local) => cloud_id(&db, "agents", local)?
                        .map(Value::from)
                        .unwrap_or(Value::Null),
                    None => Value::Null,
                },
            );
            for (k, v) in [
                ("title", val(p["title"].as_str())),
                ("description", val(p["description"].as_str())),
                ("status", val(p["status"].as_str())),
                ("priority", val(p["priority"].as_str())),
                ("dueAt", num(p["due_at"].as_i64())),
                ("createdAt", num(p["created_at"].as_i64())),
                ("updatedAt", num(p["updated_at"].as_i64())),
            ] {
                arg(&mut a, k, v);
            }
            ("desktopSync:upsertTask", "tasks")
        }
        "task_comments" => {
            let task = cloud_id(&db, "tasks", p["task_id"].as_str().ok_or("Falta task_id")?)?
                .ok_or("La tarea aún no está sincronizada")?;
            arg(&mut a, "taskId", Value::from(task));
            arg(&mut a, "kind", val(p["comment_type"].as_str()));
            arg(&mut a, "content", val(p["content"].as_str()));
            arg(&mut a, "createdAt", num(p["created_at"].as_i64()));
            ("desktopSync:upsertComment", "task_comments")
        }
        _ => return Err("Tipo de registro desconocido".into()),
    };
    match client
        .mutation(function, a)
        .await
        .map_err(|e| e.to_string())?
    {
        FunctionResult::Value(Value::String(id)) => {
            save_mapping(&db, kind, &item.local_id, &id)?;
            Ok(id)
        }
        FunctionResult::ErrorMessage(e) => Err(e),
        FunctionResult::ConvexError(e) => Err(e.message),
        _ => Err("Respuesta inesperada de Convex".into()),
    }
}

#[tauri::command]
pub async fn sync_workbench_now(
    app: AppHandle,
    convex_url: String,
    token: String,
) -> Result<u32, String> {
    if !convex_url.starts_with("https://") || token.split('.').count() != 3 {
        return Err("La sesión de Clerk o la URL de Convex no son válidas.".into());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mitpad_local.db");
    let mut client = ConvexClient::new(&convex_url)
        .await
        .map_err(|e| e.to_string())?;
    client.set_auth(Some(token)).await;
    let workspace_result = client
        .mutation("web:asegurarWorkspace", BTreeMap::new())
        .await
        .map_err(|e| e.to_string())?;
    match workspace_result {
        FunctionResult::Value(_) => {}
        FunctionResult::ErrorMessage(e) => return Err(e),
        FunctionResult::ConvexError(e) => return Err(e.message),
    }
    let initial_result = client
        .query("desktopSync:snapshot", BTreeMap::new())
        .await
        .map_err(|e| e.to_string())?;
    let initial_value = match initial_result {
        FunctionResult::Value(value) => value,
        FunctionResult::ErrorMessage(e) => return Err(e),
        FunctionResult::ConvexError(e) => return Err(e.message),
    };
    let Value::Object(initial_snapshot) = initial_value else {
        return Err("Convex devolvió una respuesta de workspace inválida.".into());
    };
    map_existing_projects(&initial_snapshot, &path)?;
    queue_existing(&path)?;
    let pending = items(&path)?;
    let mut done = 0;
    for item in pending {
        match send(&mut client, &path, &item).await {
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
    done += sync_note_queue(&mut client, &path).await?;
    done += sync_local_images(&mut client, &path).await?;
    let snapshot_result = client
        .query("desktopSync:snapshot", BTreeMap::new())
        .await
        .map_err(|e| e.to_string())?;
    let snapshot_value = match snapshot_result {
        FunctionResult::Value(value) => value,
        FunctionResult::ErrorMessage(e) => return Err(e),
        FunctionResult::ConvexError(e) => return Err(e.message),
    };
    let Value::Object(snapshot) = snapshot_value else {
        return Err("Convex devolvió una respuesta de workspace inválida.".into());
    };
    pull_cloud_projects(&snapshot, &path).await?;
    pull_cloud_agents(&snapshot, &path).await?;
    pull_cloud_tasks(&snapshot, &path).await?;
    pull_cloud_comments(&snapshot, &path).await?;
    pull_cloud_project_links(&snapshot, &path).await?;
    pull_cloud_notes(&snapshot, &path).await?;
    pull_cloud_images(&snapshot, &path).await?;
    done += sync_project_links(&mut client, &path).await?;
    let db = Connection::open(&path).map_err(|e| e.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    db.execute("INSERT INTO app_state(key,value) VALUES('last_sync_at',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[now.to_string()]).map_err(|e|e.to_string())?;
    Ok(done)
}

#[tauri::command]
pub async fn list_project_knowledge(
    app: AppHandle,
    convex_url: String,
    token: String,
) -> Result<Vec<crate::db::workbench::ProjectKnowledge>, String> {
    let mut client = ConvexClient::new(&convex_url)
        .await
        .map_err(|e| e.to_string())?;
    client.set_auth(Some(token)).await;
    let result = client
        .query("desktopSync:snapshot", BTreeMap::new())
        .await
        .map_err(|e| e.to_string())?;
    let values = match result {
        FunctionResult::Value(Value::Object(mut object)) => match object.remove("knowledge") {
            Some(Value::Array(rows)) => rows,
            _ => return Err("Convex devolvió conocimiento inesperado.".into()),
        },
        FunctionResult::ErrorMessage(error) => return Err(error),
        FunctionResult::ConvexError(error) => return Err(error.message),
        _ => return Err("Convex devolvió una lista de conocimiento inesperada.".into()),
    };
    let db_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mitpad_local.db");
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut project_ids = BTreeMap::new();
    let mut stmt = db
        .prepare("SELECT cloud_id,local_id FROM cloud_mappings WHERE entity_type='projects'")
        .map_err(|e| e.to_string())?;
    let mappings = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for mapping in mappings {
        let (cloud, local) = mapping.map_err(|e| e.to_string())?;
        project_ids.insert(cloud, local);
    }
    let mut records = Vec::new();
    for value in values {
        let Value::Object(fields) = value else {
            continue;
        };
        let Some(cloud_project_id) = text_field(&fields, "projectId") else {
            continue;
        };
        let Some(project_id) = project_ids.get(&cloud_project_id).cloned() else {
            continue;
        };
        let tags = match fields.get("tags") {
            Some(Value::Array(values)) => values
                .iter()
                .filter_map(|value| match value {
                    Value::String(tag) => Some(tag.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        records.push(crate::db::workbench::ProjectKnowledge {
            id: text_field(&fields, "id").unwrap_or_default(),
            project_id,
            kind: text_field(&fields, "kind").unwrap_or_else(|| "capability".into()),
            title: text_field(&fields, "title").unwrap_or_default(),
            summary: text_field(&fields, "summary").unwrap_or_default(),
            source: text_field(&fields, "source").unwrap_or_default(),
            tags,
            updated_at: number_field(&fields, "updatedAt").unwrap_or_default(),
        });
    }
    Ok(records)
}

#[tauri::command]
pub async fn delete_project_link(
    app: AppHandle,
    id: String,
    convex_url: String,
    token: String,
) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mitpad_local.db");
    let cloud_id_value = {
        let db = Connection::open(&path).map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT cloud_id FROM cloud_mappings WHERE entity_type='project_links' AND local_id=?1",
            [&id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    if let Some(cloud_id_value) = cloud_id_value {
        let mut client = ConvexClient::new(&convex_url)
            .await
            .map_err(|e| e.to_string())?;
        client.set_auth(Some(token)).await;
        let mut args = BTreeMap::new();
        arg(&mut args, "id", Value::from(cloud_id_value));
        match client
            .mutation("desktopSync:deleteLink", args)
            .await
            .map_err(|e| e.to_string())?
        {
            FunctionResult::Value(_) => {}
            FunctionResult::ErrorMessage(e) => return Err(e),
            FunctionResult::ConvexError(e) => return Err(e.message),
        }
    }
    let db = Connection::open(&path).map_err(|e| e.to_string())?;
    db.execute("DELETE FROM project_links WHERE id=?1", [&id])
        .map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM cloud_mappings WHERE entity_type='project_links' AND local_id=?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
