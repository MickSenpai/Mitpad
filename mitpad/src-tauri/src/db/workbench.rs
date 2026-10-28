use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::json;
use tauri::State;
use uuid::Uuid;

use super::{ahora_ms, queries::DbState};

type Error = String;

#[derive(Debug, Clone, Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectLink {
    pub id: String,
    pub source_project_id: String,
    pub target_project_id: String,
    pub relation_type: String,
    pub description: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectKnowledge {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub source: String,
    pub tags: Vec<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub assignee_agent_id: Option<String>,
    pub due_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskComment {
    pub id: String,
    pub task_id: String,
    pub actor_type: String,
    pub actor: String,
    pub comment_type: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityEvent {
    pub id: String,
    pub project_id: Option<String>,
    pub actor_type: String,
    pub actor: String,
    pub event_type: String,
    pub entity_type: String,
    pub entity_id: String,
    pub payload: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub client_type: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}

pub(crate) fn record_event(
    tx: &Transaction<'_>,
    project_id: Option<&str>,
    event_type: &str,
    entity_type: &str,
    entity_id: &str,
    payload: serde_json::Value,
) -> Result<(), Error> {
    tx.execute(
        "INSERT INTO activity_events (id, project_id, actor_type, actor, event_type, entity_type, entity_id, payload, created_at)
         VALUES (?1, ?2, 'human', 'pilot', ?3, ?4, ?5, ?6, ?7)",
        params![Uuid::new_v4().to_string(), project_id, event_type, entity_type, entity_id, payload.to_string(), ahora_ms()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn queue_sync(
    tx: &Transaction<'_>,
    entity_type: &str,
    local_id: &str,
    payload: &impl Serialize,
) -> Result<(), Error> {
    tx.execute(
        "INSERT INTO workbench_sync_queue (entity_type, local_id, payload, status, attempts, last_error, created_at)
         VALUES (?1, ?2, ?3, 'pending', 0, NULL, ?4)
         ON CONFLICT(entity_type, local_id) DO UPDATE SET payload=excluded.payload, status='pending', attempts=0, last_error=NULL, created_at=excluded.created_at",
        params![entity_type, local_id, serde_json::to_string(payload).map_err(|e| e.to_string())?, ahora_ms()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn validate_status(status: &str) -> Result<(), Error> {
    if [
        "backlog",
        "todo",
        "in_progress",
        "review",
        "blocked",
        "done",
    ]
    .contains(&status)
    {
        Ok(())
    } else {
        Err("Estado de tarea inválido.".into())
    }
}

fn validate_priority(priority: &str) -> Result<(), Error> {
    if ["low", "medium", "high", "urgent"].contains(&priority) {
        Ok(())
    } else {
        Err("Prioridad inválida.".into())
    }
}

#[tauri::command]
pub fn create_project(
    state: State<'_, DbState>,
    name: String,
    description: String,
) -> Result<Project, Error> {
    let name = name.trim().to_owned();
    if name.is_empty() || name.len() > 160 {
        return Err("El nombre debe tener entre 1 y 160 caracteres.".into());
    }
    if description.len() > 20_000 {
        return Err("La descripción supera el límite de 20 KB.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let now = ahora_ms();
    let project = Project {
        id: Uuid::new_v4().to_string(),
        name,
        description,
        status: "active".into(),
        created_at: now,
        updated_at: now,
    };
    tx.execute("INSERT INTO projects (id, name, description, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)", params![project.id, project.name, project.description, now]).map_err(|e| e.to_string())?;
    record_event(
        &tx,
        Some(&project.id),
        "project.created",
        "project",
        &project.id,
        json!({"name": project.name}),
    )?;
    queue_sync(&tx, "projects", &project.id, &project)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
pub fn list_projects(state: State<'_, DbState>) -> Result<Vec<Project>, Error> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, description, status, created_at, updated_at FROM projects ORDER BY updated_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                status: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_project_links(state: State<'_, DbState>) -> Result<Vec<ProjectLink>, Error> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let mut stmt = conn.prepare("SELECT id,source_project_id,target_project_id,relation_type,description,created_at FROM project_links ORDER BY created_at").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProjectLink {
                id: r.get(0)?,
                source_project_id: r.get(1)?,
                target_project_id: r.get(2)?,
                relation_type: r.get(3)?,
                description: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_project_link(
    state: State<'_, DbState>,
    source_project_id: String,
    target_project_id: String,
    relation_type: String,
    description: String,
) -> Result<ProjectLink, Error> {
    if source_project_id == target_project_id {
        return Err("Selecciona dos proyectos distintos.".into());
    }
    if !["related_to", "parent_of", "depends_on"].contains(&relation_type.as_str()) {
        return Err("Tipo de relación inválido.".into());
    }
    let description = description.trim().to_owned();
    if description.len() > 1000 {
        return Err("La descripción de la relación supera 1000 caracteres.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let count: i64 = tx
        .query_row(
            "SELECT count(*) FROM projects WHERE id IN (?1,?2) AND status='active'",
            params![source_project_id, target_project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count != 2 {
        return Err("Ambos proyectos deben existir y estar activos.".into());
    }
    let link = ProjectLink {
        id: Uuid::new_v4().to_string(),
        source_project_id,
        target_project_id,
        relation_type,
        description,
        created_at: ahora_ms(),
    };
    tx.execute("INSERT INTO project_links(id,source_project_id,target_project_id,relation_type,description,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(source_project_id,target_project_id) DO UPDATE SET relation_type=excluded.relation_type,description=excluded.description", params![link.id,link.source_project_id,link.target_project_id,link.relation_type,link.description,link.created_at]).map_err(|e|e.to_string())?;
    let saved = tx.query_row("SELECT id,source_project_id,target_project_id,relation_type,description,created_at FROM project_links WHERE source_project_id=?1 AND target_project_id=?2", params![link.source_project_id,link.target_project_id], |r| Ok(ProjectLink{id:r.get(0)?,source_project_id:r.get(1)?,target_project_id:r.get(2)?,relation_type:r.get(3)?,description:r.get(4)?,created_at:r.get(5)?})).map_err(|e|e.to_string())?;
    record_event(
        &tx,
        Some(&saved.source_project_id),
        "project.linked",
        "project_link",
        &saved.id,
        json!({"target_project_id":saved.target_project_id,"relation_type":saved.relation_type,"description":saved.description}),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(saved)
}

#[tauri::command]
pub fn create_task(
    state: State<'_, DbState>,
    project_id: String,
    title: String,
    description: String,
    priority: String,
    assignee_agent_id: Option<String>,
    due_at: Option<i64>,
) -> Result<Task, Error> {
    let title = title.trim().to_owned();
    if title.is_empty() || title.len() > 240 {
        return Err("El título debe tener entre 1 y 240 caracteres.".into());
    }
    if description.len() > 100_000 {
        return Err("La descripción de la tarea supera el límite de 100 KB.".into());
    }
    validate_priority(&priority)?;
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1 AND status = 'active')",
            [&project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("El proyecto no existe o está archivado.".into());
    }
    if let Some(agent_id) = assignee_agent_id.as_deref() {
        let active: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND status='active')",
                [agent_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !active {
            return Err("El agente asignado no existe o está desactivado.".into());
        }
    }
    let now = ahora_ms();
    let task = Task {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.clone(),
        title,
        description,
        status: "todo".into(),
        priority,
        assignee_agent_id: assignee_agent_id.clone(),
        due_at,
        created_at: now,
        updated_at: now,
    };
    tx.execute("INSERT INTO tasks (id, project_id, title, description, status, priority, assignee_agent_id, due_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'todo', ?5, ?6, ?7, ?8, ?8)", params![task.id, task.project_id, task.title, task.description, task.priority, task.assignee_agent_id, due_at, now]).map_err(|e| e.to_string())?;
    record_event(
        &tx,
        Some(&project_id),
        "task.created",
        "task",
        &task.id,
        json!({"title": task.title, "priority": task.priority}),
    )?;
    queue_sync(&tx, "tasks", &task.id, &task)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(task)
}

#[tauri::command]
pub fn list_tasks(state: State<'_, DbState>, project_id: String) -> Result<Vec<Task>, Error> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let mut stmt = conn.prepare("SELECT id, project_id, title, description, status, priority, assignee_agent_id, due_at, created_at, updated_at FROM tasks WHERE project_id = ?1 ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC LIMIT 1000").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project_id], |r| {
            Ok(Task {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                description: r.get(3)?,
                status: r.get(4)?,
                priority: r.get(5)?,
                assignee_agent_id: r.get(6)?,
                due_at: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC keeps the task fields explicit for the Svelte client.
pub fn update_task(
    state: State<'_, DbState>,
    id: String,
    title: String,
    description: String,
    status: String,
    priority: String,
    assignee_agent_id: Option<String>,
    due_at: Option<i64>,
) -> Result<Task, Error> {
    validate_status(&status)?;
    validate_priority(&priority)?;
    let title = title.trim().to_owned();
    if title.is_empty() || title.len() > 240 {
        return Err("El título debe tener entre 1 y 240 caracteres.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let previous: Task = tx.query_row("SELECT id, project_id, title, description, status, priority, assignee_agent_id, due_at, created_at, updated_at FROM tasks WHERE id = ?1", [&id], |r| Ok(Task { id: r.get(0)?, project_id: r.get(1)?, title: r.get(2)?, description: r.get(3)?, status: r.get(4)?, priority: r.get(5)?, assignee_agent_id: r.get(6)?, due_at: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)? })).optional().map_err(|e| e.to_string())?.ok_or_else(|| "No existe la tarea.".to_string())?;
    if let Some(agent_id) = assignee_agent_id.as_deref() {
        let active: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND status='active')",
                [agent_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !active {
            return Err("El agente asignado no existe o está desactivado.".into());
        }
    }
    let now = ahora_ms();
    tx.execute("UPDATE tasks SET title = ?1, description = ?2, status = ?3, priority = ?4, assignee_agent_id = ?5, due_at = ?6, updated_at = ?7 WHERE id = ?8", params![title, description, status, priority, assignee_agent_id, due_at, now, id]).map_err(|e| e.to_string())?;
    record_event(
        &tx,
        Some(&previous.project_id),
        "task.updated",
        "task",
        &id,
        json!({"from_status": previous.status, "to_status": status, "title": title}),
    )?;
    queue_sync(
        &tx,
        "tasks",
        &id,
        &json!({"id": id, "project_id": previous.project_id, "title": title, "description": description, "status": status, "priority": priority, "assignee_agent_id": assignee_agent_id, "due_at": due_at, "created_at": previous.created_at, "updated_at": now}),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    let updated: Task = conn.query_row("SELECT id, project_id, title, description, status, priority, assignee_agent_id, due_at, created_at, updated_at FROM tasks WHERE id = ?1", [&id], |r| Ok(Task { id: r.get(0)?, project_id: r.get(1)?, title: r.get(2)?, description: r.get(3)?, status: r.get(4)?, priority: r.get(5)?, assignee_agent_id: r.get(6)?, due_at: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)? })).map_err(|e| e.to_string())?;
    Ok(updated)
}

#[tauri::command]
pub fn create_task_comment(
    state: State<'_, DbState>,
    task_id: String,
    comment_type: String,
    content: String,
) -> Result<TaskComment, Error> {
    if ![
        "message",
        "instruction",
        "question",
        "decision",
        "update",
        "answer",
    ]
    .contains(&comment_type.as_str())
    {
        return Err("Tipo de comentario inválido.".into());
    }
    let content = content.trim().to_owned();
    if content.is_empty() || content.len() > 20_000 {
        return Err("El comentario debe tener entre 1 y 20 KB.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let project_id: String = tx
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [&task_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let comment = TaskComment {
        id: Uuid::new_v4().to_string(),
        task_id,
        actor_type: "human".into(),
        actor: "pilot".into(),
        comment_type,
        content,
        created_at: ahora_ms(),
    };
    tx.execute("INSERT INTO task_comments (id, task_id, actor_type, actor, comment_type, content, created_at) VALUES (?1, ?2, 'human', 'pilot', ?3, ?4, ?5)", params![comment.id, comment.task_id, comment.comment_type, comment.content, comment.created_at]).map_err(|e| e.to_string())?;
    record_event(
        &tx,
        Some(&project_id),
        "task.comment_added",
        "task",
        &comment.task_id,
        json!({"comment_type": comment.comment_type, "content": comment.content}),
    )?;
    queue_sync(
        &tx,
        "task_comments",
        &comment.id,
        &json!({"id": comment.id, "task_id": comment.task_id, "comment_type": comment.comment_type, "content": comment.content, "created_at": comment.created_at}),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(comment)
}

#[tauri::command]
pub fn list_task_comments(
    state: State<'_, DbState>,
    task_id: String,
) -> Result<Vec<TaskComment>, Error> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let mut stmt = conn.prepare("SELECT id, task_id, actor_type, actor, comment_type, content, created_at FROM task_comments WHERE task_id = ?1 ORDER BY created_at DESC LIMIT 200").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([task_id], |r| {
            Ok(TaskComment {
                id: r.get(0)?,
                task_id: r.get(1)?,
                actor_type: r.get(2)?,
                actor: r.get(3)?,
                comment_type: r.get(4)?,
                content: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_activity(
    state: State<'_, DbState>,
    project_id: Option<String>,
) -> Result<Vec<ActivityEvent>, Error> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    if let Some(project_id) = project_id {
        let mut stmt = conn.prepare("SELECT id, project_id, actor_type, actor, event_type, entity_type, entity_id, payload, created_at FROM activity_events WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 200").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(ActivityEvent {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    actor_type: r.get(2)?,
                    actor: r.get(3)?,
                    event_type: r.get(4)?,
                    entity_type: r.get(5)?,
                    entity_id: r.get(6)?,
                    payload: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    } else {
        let mut stmt = conn.prepare("SELECT id, project_id, actor_type, actor, event_type, entity_type, entity_id, payload, created_at FROM activity_events ORDER BY created_at DESC LIMIT 200").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ActivityEvent {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    actor_type: r.get(2)?,
                    actor: r.get(3)?,
                    event_type: r.get(4)?,
                    entity_type: r.get(5)?,
                    entity_id: r.get(6)?,
                    payload: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn create_local_agent(
    state: State<'_, DbState>,
    name: String,
    model: Option<String>,
    provider: Option<String>,
    client_type: Option<String>,
) -> Result<Agent, Error> {
    let name = name.trim().to_owned();
    if name.is_empty() || name.len() > 120 {
        return Err("El nombre del agente debe tener entre 1 y 120 caracteres.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let now = ahora_ms();
    let agent = Agent {
        id: Uuid::new_v4().to_string(),
        name,
        model,
        provider,
        client_type,
        status: "active".into(),
        created_at: now,
        last_seen_at: None,
    };
    tx.execute("INSERT INTO agents (id, name, model, provider, client_type, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)", params![agent.id, agent.name, agent.model, agent.provider, agent.client_type, now]).map_err(|e| e.to_string())?;
    record_event(
        &tx,
        None,
        "agent.registered_locally",
        "agent",
        &agent.id,
        json!({"name": agent.name, "model": agent.model, "provider": agent.provider}),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(agent)
}

#[tauri::command]
pub fn update_local_agent(
    state: State<'_, DbState>,
    id: String,
    name: String,
    model: Option<String>,
    provider: Option<String>,
    client_type: Option<String>,
) -> Result<Agent, Error> {
    let name = if id == "meido-primary-agent" {
        "Meido".to_string()
    } else {
        name.trim().to_owned()
    };
    if name.is_empty() || name.len() > 120 {
        return Err("El nombre del agente debe tener entre 1 y 120 caracteres.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let (provider, client_type) = if id == "meido-primary-agent" {
        (Some("Mitpad".to_string()), Some("primary".to_string()))
    } else {
        (provider, client_type)
    };
    let changed = conn
        .execute(
            "UPDATE agents SET name=?1, model=?2, provider=?3, client_type=?4 WHERE id=?5",
            params![name, model, provider, client_type, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("No existe el agente.".into());
    }
    conn.query_row("SELECT id,name,model,provider,client_type,status,created_at,last_seen_at FROM agents WHERE id=?1",[id],|r|Ok(Agent{id:r.get(0)?,name:r.get(1)?,model:r.get(2)?,provider:r.get(3)?,client_type:r.get(4)?,status:r.get(5)?,created_at:r.get(6)?,last_seen_at:r.get(7)?})).map_err(|e|e.to_string())
}

#[tauri::command]
pub fn delete_local_agent(state: State<'_, DbState>, id: String) -> Result<(), Error> {
    if id == "meido-primary-agent" {
        return Err("Meido es la agente principal y no se puede desactivar.".into());
    }
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    let changed = conn
        .execute("UPDATE agents SET status='disabled' WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("No existe el agente.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_agents(state: State<'_, DbState>) -> Result<Vec<Agent>, Error> {
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Error al bloquear SQLite".to_string())?;
    conn.execute("INSERT OR IGNORE INTO agents(id,name,model,provider,client_type,status,created_at) VALUES('meido-primary-agent','Meido','Orquestadora principal','Mitpad','primary','active',?1)",[ahora_ms()]).map_err(|e|e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, model, provider, client_type, status, created_at, last_seen_at FROM agents ORDER BY CASE WHEN id='meido-primary-agent' THEN 0 ELSE 1 END, created_at DESC LIMIT 200").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Agent {
                id: r.get(0)?,
                name: r.get(1)?,
                model: r.get(2)?,
                provider: r.get(3)?,
                client_type: r.get(4)?,
                status: r.get(5)?,
                created_at: r.get(6)?,
                last_seen_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
