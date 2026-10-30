// Nube de Mitpad (antes en Neon). Los ids de notas y usuarios los genera la app
// (UUID v4, igual que en su SQLite local), así una nota creada sin red conserva
// su id al subirse. Las fechas son milisegundos desde 1970.
import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

const { users: _authUsers, ...authTablesWithoutUsers } = authTables;

export default defineSchema({
  ...authTablesWithoutUsers,
  workspaces: defineTable({
    ownerId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  // Authenticated web accounts map to private workspaces; legacy ownerId remains for desktop agents.
  webAccounts: defineTable({
    tokenIdentifier: v.string(), // sesión actual; se conserva para compatibilidad con Clerk durante transición
    userId: v.optional(v.id("users")), // identidad estable de Convex Auth, independiente de la sesión
    workspaceId: v.id("workspaces"),
    createdAt: v.number(),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_userId", ["userId"])
    .index("by_workspaceId", ["workspaceId"]),

  agents: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    model: v.string(),
    modelProvider: v.string(),
    clientType: v.string(),
    pilot: v.string(),
    apiKeyHash: v.string(),
    credentialMode: v.optional(v.union(v.literal("local"), v.literal("mcp"))),
    active: v.boolean(),
    createdAt: v.number(),
    lastSeenAt: v.optional(v.number()),
  })
    .index("by_apiKeyHash", ["apiKeyHash"])
    .index("by_workspaceId_and_createdAt", ["workspaceId", "createdAt"]),

  projects: defineTable({
    workspaceId: v.id("workspaces"),
    clientId: v.optional(v.string()),
    name: v.string(),
    description: v.string(),
    status: v.union(v.literal("active"), v.literal("archived")),
    createdByType: v.union(v.literal("human"), v.literal("agent")),
    createdById: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspaceId_and_clientId", ["workspaceId", "clientId"])
    .index("by_workspaceId_and_updatedAt", ["workspaceId", "updatedAt"])
    .index("by_workspaceId_and_status_and_updatedAt", ["workspaceId", "status", "updatedAt"]),

  projectLinks: defineTable({
    workspaceId: v.id("workspaces"),
    clientId: v.optional(v.string()),
    sourceProjectId: v.id("projects"),
    targetProjectId: v.id("projects"),
    relationType: v.union(v.literal("related_to"), v.literal("parent_of"), v.literal("depends_on")),
    description: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_workspaceId_and_clientId", ["workspaceId", "clientId"])
    .index("by_workspaceId_and_createdAt", ["workspaceId", "createdAt"])
    .index("by_sourceProjectId_and_targetProjectId", ["sourceProjectId", "targetProjectId"])
    .index("by_targetProjectId", ["targetProjectId"]),

  // Cascades run in bounded scheduled batches so large projects can be removed safely.
  projectDeletionJobs: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    projectName: v.string(),
    phase: v.union(
      v.literal("notes"), v.literal("images"), v.literal("comments"), v.literal("tasks"),
      v.literal("knowledge"), v.literal("sourceLinks"), v.literal("targetLinks"),
      v.literal("events"), v.literal("finish"),
    ),
    actorType: v.union(v.literal("human"), v.literal("agent")),
    actorId: v.string(),
    createdAt: v.number(),
  }).index("by_projectId", ["projectId"]),

  // Technical summaries derived from source structure and project docs.
  // Runtime/user records and personal information are deliberately excluded.
  projectKnowledge: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    clientId: v.string(),
    kind: v.union(
      v.literal("module"), v.literal("function"), v.literal("data"),
      v.literal("capability"), v.literal("integration"), v.literal("decision"),
    ),
    title: v.string(),
    summary: v.string(),
    source: v.string(),
    tags: v.array(v.string()),
    updatedAt: v.number(),
  })
    .index("by_workspaceId_and_projectId", ["workspaceId", "projectId"])
    .index("by_workspaceId_and_clientId", ["workspaceId", "clientId"])
    .index("by_projectId_and_kind", ["projectId", "kind"]),

  tasks: defineTable({
    workspaceId: v.id("workspaces"),
    clientId: v.optional(v.string()),
    projectId: v.id("projects"),
    parentTaskId: v.optional(v.id("tasks")),
    title: v.string(),
    description: v.string(),
    status: v.union(
      v.literal("backlog"), v.literal("todo"), v.literal("in_progress"),
      v.literal("review"), v.literal("done"), v.literal("blocked"),
    ),
    priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")),
    dueAt: v.optional(v.number()),
    assigneeAgentId: v.optional(v.id("agents")),
    createdByType: v.union(v.literal("human"), v.literal("agent")),
    createdById: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspaceId_and_clientId", ["workspaceId", "clientId"])
    .index("by_workspaceId_and_updatedAt", ["workspaceId", "updatedAt"])
    .index("by_workspaceId_and_status_and_updatedAt", ["workspaceId", "status", "updatedAt"])
    .index("by_projectId_and_updatedAt", ["projectId", "updatedAt"])
    .index("by_projectId_and_status_and_updatedAt", ["projectId", "status", "updatedAt"])
    .index("by_assigneeAgentId_and_status", ["assigneeAgentId", "status"]),

  taskComments: defineTable({
    workspaceId: v.id("workspaces"),
    clientId: v.optional(v.string()),
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    authorType: v.union(v.literal("human"), v.literal("agent")),
    authorId: v.string(),
    kind: v.union(
      v.literal("message"), v.literal("instruction"), v.literal("question"),
      v.literal("answer"), v.literal("decision"), v.literal("update"),
    ),
    content: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspaceId_and_clientId", ["workspaceId", "clientId"])
    .index("by_taskId_and_createdAt", ["taskId", "createdAt"])
    .index("by_workspaceId_and_createdAt", ["workspaceId", "createdAt"])
    .index("by_projectId_and_createdAt", ["projectId", "createdAt"]),

  // Append-only: workbench mutations add events atomically with each change.
  activityEvents: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.optional(v.id("projects")),
    actorType: v.union(v.literal("human"), v.literal("agent")),
    actorId: v.string(),
    eventType: v.union(
      v.literal("project_created"), v.literal("project_updated"), v.literal("project_archived"), v.literal("project_deleted"),
      v.literal("task_created"), v.literal("task_updated"),
      v.literal("comment_created"), v.literal("agent_registered"), v.literal("agent_updated"), v.literal("agent_revoked"), v.literal("note_created"), v.literal("note_updated"), v.literal("note_linked"), v.literal("note_deleted"),
    ),
    entityType: v.union(v.literal("project"), v.literal("task"), v.literal("comment"), v.literal("agent"), v.literal("note")),
    entityId: v.string(),
    summary: v.string(),
    details: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_workspaceId_and_createdAt", ["workspaceId", "createdAt"])
    .index("by_projectId_and_createdAt", ["projectId", "createdAt"]),

  users: defineTable({
    // Campos requeridos por Convex Auth
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    profileImageStorageId: v.optional(v.id("_storage")),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // Campos históricos de Mitpad; opcionales para no invalidar usuarios existentes
    uuid: v.optional(v.string()),
    nombre: v.optional(v.string()),
    entorno: v.optional(v.string()),
    gustos: v.optional(v.any()),
    odia: v.optional(v.any()),
    proyectos: v.optional(v.any()),
    createdAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_uuid", ["uuid"]),

  notes: defineTable({
    uuid: v.string(),
    userId: v.string(), // uuid del usuario
    workspaceId: v.optional(v.id("workspaces")),
    projectId: v.optional(v.id("projects")),
    status: v.optional(v.union(v.literal("open"), v.literal("attended"))),
    deletedAt: v.optional(v.number()),
    kind: v.optional(v.union(v.literal("note"), v.literal("memory"))),
    title: v.optional(v.string()),
    content: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_uuid", ["uuid"])
    .index("by_userId_and_updatedAt", ["userId", "updatedAt"])
    .index("by_workspaceId_and_updatedAt", ["workspaceId", "updatedAt"])
    .index("by_projectId", ["projectId"]),

  noteImages: defineTable({
    workspaceId: v.id("workspaces"),
    localId: v.optional(v.string()),
    noteId: v.optional(v.string()), // UUID local de la nota existente
    projectId: v.optional(v.id("projects")),
    storageId: v.id("_storage"),
    filename: v.string(),
    contentType: v.string(),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_workspaceId_and_localId", ["workspaceId", "localId"])
    .index("by_workspaceId_and_createdAt", ["workspaceId", "createdAt"])
    .index("by_noteId_and_createdAt", ["noteId", "createdAt"])
    .index("by_projectId_and_createdAt", ["projectId", "createdAt"]),

  // Relaciones entre notas, tipo Obsidian
  noteLinks: defineTable({
    uuid: v.string(),
    sourceNoteId: v.string(), // uuid de la nota
    targetNoteId: v.string(),
    createdAt: v.number(),
  })
    .index("by_uuid", ["uuid"])
    .index("by_sourceNoteId_and_targetNoteId", ["sourceNoteId", "targetNoteId"])
    .index("by_targetNoteId", ["targetNoteId"]),
});
