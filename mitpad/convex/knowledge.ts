import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { exigirToken, userIdPersonal } from "./acceso";
import { asegurarWorkspace } from "./workspaces";

const kind = v.union(v.literal("module"), v.literal("function"), v.literal("data"), v.literal("capability"), v.literal("integration"), v.literal("decision"));
const output = v.object({ id: v.id("projectKnowledge"), projectId: v.id("projects"), kind, title: v.string(), summary: v.string(), source: v.string(), tags: v.array(v.string()), updatedAt: v.number() });
type Kind = "module" | "function" | "data" | "capability" | "integration" | "decision";
type Entry = { project: string; key: string; kind: Kind; title: string; summary: string; source: string; tags: string[] };
const entries: Entry[] = [
  { project: "Meido", key: "desktop", kind: "module", title: "Aplicación de escritorio", summary: "Cliente Linux con PyQt, voz, herramientas locales y servicios auxiliares.", source: "python-backend/meido_GUI.py; python-backend/main.py", tags: ["desktop", "python"] },
  { project: "Meido", key: "conversation", kind: "module", title: "Orquestación de conversación", summary: "Prepara contexto, enruta peticiones a modelos y coordina llamadas a herramientas.", source: "python-backend/dispatcher.py; python-backend/P_API_handler.py", tags: ["chat", "llm"] },
  { project: "Meido", key: "dispatch", kind: "function", title: "dispatch / process_full", summary: "Clasifica peticiones y coordina respuesta normal o trabajo multiagente.", source: "python-backend/dispatcher.py", tags: ["entrypoint", "routing"] },
  { project: "Meido", key: "prompt", kind: "function", title: "build_system_prompt", summary: "Compone instrucciones con memoria, proyecto activo, estado y herramientas habilitadas.", source: "python-backend/P_API_handler.py", tags: ["context", "prompt"] },
  { project: "Meido", key: "tools", kind: "module", title: "Herramientas del sistema", summary: "Acciones para archivos, sistema, calendario, correo, agentes, navegador, audio y ProjectHub.", source: "python-backend/tools.py; python-backend/seleccion_herramientas.py", tags: ["tools", "automation"] },
  { project: "Meido", key: "file-safety", kind: "decision", title: "Cambios con aprobación", summary: "Valida rutas y solicita confirmación para acciones de riesgo; admite deshacer y revisar propuestas.", source: "python-backend/agente_archivos.py; python-backend/confirmacion.py; python-backend/propuestas.py", tags: ["safety", "approval"] },
  { project: "Meido", key: "agents", kind: "module", title: "Coordinación de agentes", summary: "Coordina OpenCode y otros clientes; publica sesiones, permisos, instrucciones y resultados.", source: "python-backend/multi_agent.py; python-backend/puente_opencode.py; python-backend/puente_agentes.py", tags: ["agents", "coding"] },
  { project: "Meido", key: "island", kind: "module", title: "Isla de Meido", summary: "Overlay de escritorio con estado, sesiones, permisos y control de agentes integrado con Hyprland.", source: "python-backend/isla_meido.py; python-backend/isla.py; python-backend/isla_sesiones.py", tags: ["desktop", "overlay"] },
  { project: "Meido", key: "hooks", kind: "integration", title: "Hooks de Claude Code y Codex", summary: "Publican actividad, preguntas de permiso e inicio y cierre de sesión en la isla.", source: "python-backend/isla_hooks_claude.py; python-backend/isla_hooks_codex.py", tags: ["agents", "hooks"] },
  { project: "Meido", key: "memory", kind: "data", title: "Memoria y perfil", summary: "Perfil, recuerdos y resúmenes locales; Convex permite sincronizar y buscar recuerdos semánticamente.", source: "python-backend/db_memory.py; python-backend/chat_memory.py; convex/memoria.ts", tags: ["memory", "vectors"] },
  { project: "Meido", key: "convex-data", kind: "data", title: "Datos compartidos", summary: "Mensajes, memoria vectorial, encargos, aprobaciones, actividad, recordatorios y puentes.", source: "convex/schema.ts; convex/mensajes.ts; convex/actividad.ts; convex/puente.ts", tags: ["convex", "sync"] },
  { project: "Meido", key: "pc-mobile", kind: "integration", title: "Puente escritorio–móvil", summary: "Convex transporta mensajes, órdenes, latidos, aprobaciones y recordatorios entre dispositivos.", source: "python-backend/puente_movil.py; python-backend/nube.py; convex/puente.ts", tags: ["mobile", "convex"] },
  { project: "Meido", key: "voice-vision", kind: "capability", title: "Voz y visión", summary: "Whisper, XTTS/Piper, capturas, OCR y lectura de ventanas visibles.", source: "python-backend/voice_module.py; python-backend/voice_xtts.py; python-backend/vision_profunda.py; python-backend/leer_ventana.py", tags: ["voice", "vision"] },
  { project: "Meido", key: "integrations", kind: "integration", title: "Servicios opcionales", summary: "Gmail de lectura, Google Calendar, Spotify, Telegram, KDE Connect y navegador.", source: "python-backend/gmail_lectura.py; python-backend/google_calendario.py; python-backend/spotify_control.py; python-backend/enlace.py", tags: ["integrations"] },
  { project: "Meido", key: "offline", kind: "decision", title: "Continuidad sin red", summary: "Cache local, fallback a Ollama y colas conservan parte del trabajo sin conexión.", source: "python-backend/local_cache.py; python-backend/ollama_fallback.py; python-backend/sync_nube.py", tags: ["offline", "resilience"] },
  { project: "Meido", key: "projecthub", kind: "integration", title: "ProjectHub MCP", summary: "Consulta proyectos y tareas y permite delegar trabajo según el proyecto activo.", source: "python-backend/projecthub.py; python-backend/mcp_client.py", tags: ["mcp", "projects"] },
  { project: "Meido", key: "extras", kind: "capability", title: "Extensión y mundo visual", summary: "La extensión Brave comparte pestañas; el experimento mundo conecta el personaje con VoxPix.", source: "extension_brave/; mundo/README.md", tags: ["browser", "voxels"] },
  { project: "meido_movil", key: "flutter", kind: "module", title: "Cliente Android Flutter", summary: "App móvil para conversar con Meido y continuar trabajo compartido con escritorio y nube.", source: "lib/main.dart; pubspec.yaml", tags: ["flutter", "android"] },
  { project: "meido_movil", key: "brain", kind: "module", title: "Chat y cerebro", summary: "Gestiona turnos, herramientas, contexto y modos PC, móvil y sin red.", source: "lib/chat.dart; lib/cerebro.dart; lib/nube.dart", tags: ["chat", "tools"] },
  { project: "meido_movil", key: "cloud", kind: "integration", title: "Nube y sincronización", summary: "Convex comparte mensajes, agentes, encargos y aprobaciones.", source: "lib/nube.dart; lib/projecthub.dart", tags: ["convex", "sync"] },
  { project: "meido_movil", key: "offline", kind: "data", title: "Cola sin conexión", summary: "Conserva órdenes pendientes para reintentarlas cuando vuelve la conectividad.", source: "lib/offline.dart", tags: ["offline", "queue"] },
  { project: "meido_movil", key: "agents", kind: "capability", title: "Supervisión de agentes", summary: "Muestra encargos, sesiones, actividad, preguntas y permisos de agentes.", source: "lib/pantalla_agentes.dart; lib/hoja_pregunta.dart", tags: ["agents", "monitoring"] },
  { project: "meido_movil", key: "phone-tools", kind: "capability", title: "Voz y herramientas móviles", summary: "Incluye voz, rutinas, ajustes, diagnóstico, notificaciones y WhatsApp.", source: "lib/voz.dart; lib/ajustes.dart; lib/rutinas.dart; lib/whatsapp_mensajes.dart; lib/pantalla_diagnostico.dart", tags: ["voice", "android"] },
  { project: "Mitpad", key: "local-first", kind: "module", title: "Escritorio local-first", summary: "SvelteKit/Tauri y SQLite guardan proyectos, tareas, notas e imágenes con cola de reintentos.", source: "src/routes/+page.svelte; src-tauri/src/db/; src-tauri/src/sync/", tags: ["tauri", "sqlite", "offline"] },
  { project: "Mitpad", key: "workbench", kind: "data", title: "Workspace de Convex", summary: "Workspace, proyectos, relaciones, agentes, tareas, comentarios, eventos y notas.", source: "convex/schema.ts; convex/workbench.ts; convex/workspaces.ts", tags: ["convex", "schema"] },
  { project: "Mitpad", key: "tasks", kind: "capability", title: "Flujo de tareas", summary: "Estados backlog, por hacer, en curso, revisión, bloqueado y hecho; prioridades y asignaciones.", source: "convex/workbench.ts; src/routes/+page.svelte", tags: ["tasks", "workflow"] },
  { project: "Mitpad", key: "agents", kind: "data", title: "Registro de agentes", summary: "Identidad, modelo, proveedor, cliente, estado y clave API guardada como hash.", source: "convex/agents.ts; convex/schema.ts", tags: ["agents", "security"] },
  { project: "Mitpad", key: "notes-images", kind: "capability", title: "Notas, memoria e imágenes", summary: "Notas atendidas o activas, vínculos a proyectos y adjuntos en Convex Storage con cuotas.", source: "convex/notes.ts; convex/images.ts; src-tauri/src/db/images.rs", tags: ["notes", "images"] },
  { project: "Mitpad", key: "activity", kind: "data", title: "Historial de actividad", summary: "Registra actor, entidad, resumen y fecha para observar acciones de agentes.", source: "convex/workbench.ts; convex/schema.ts", tags: ["activity", "audit"] },
  { project: "Mitpad", key: "map", kind: "capability", title: "Mapa 3D", summary: "Grafo espacial de proyectos, tareas y conocimiento técnico.", source: "src/lib/ThreeDGraph.svelte; convex/knowledge.ts", tags: ["graph", "3d"] },
  { project: "Mitpad", key: "web", kind: "capability", title: "Monitoreo web", summary: "Panel de proyectos, tareas, agentes y actividad con actualización periódica desde Convex.", source: "src/lib/WebWorkbench.svelte", tags: ["web", "monitoring"] },
  { project: "Mitpad", key: "auth", kind: "decision", title: "Identidad web Clerk", summary: "Clerk autentica y Convex valida la sesión; el bundle web no debe contener el token privado de la app.", source: "convex/auth.config.ts; src/lib/WebWorkbench.svelte", tags: ["clerk", "auth"] },
  { project: "CosechIA", key: "laravel", kind: "module", title: "Plataforma Laravel", summary: "Laravel 13, PHP 8.4 e Inertia/Vue con áreas de administración y viticultura.", source: "composer.json; routes/web.php; routes/admin.php", tags: ["laravel", "inertia"] },
  { project: "CosechIA", key: "tenant", kind: "decision", title: "Autorización por rol", summary: "Roles y políticas limitan viñedos, bloques y operaciones al usuario autorizado.", source: "app/Policies/; app/Models/User.php", tags: ["auth", "tenant"] },
  { project: "CosechIA", key: "vineyards", kind: "data", title: "Dominio vitícola", summary: "Valles, viñedos, bloques, ciclos, etapas, variedades, suelo, portainjertos y riego.", source: "app/Models/Vinedo.php; app/Models/Bloque.php; app/Models/Ciclo.php; database/migrations/", tags: ["viticulture", "data"] },
  { project: "CosechIA", key: "phenology", kind: "capability", title: "Fenología y ciclos", summary: "Relaciona etapas del cultivo con fechas planificadas y observadas en cada ciclo.", source: "app/Services/Dashboard/FenologiaService.php; app/Services/Vintner/CicloEtapaService.php", tags: ["phenology", "calendar"] },
  { project: "CosechIA", key: "weather", kind: "integration", title: "Clima y pronósticos", summary: "Actualiza clima por valle y alimenta paneles y decisiones agronómicas.", source: "app/Services/Weather/; app/Services/Vintner/BitacoraWeatherService.php", tags: ["weather", "forecast"] },
  { project: "CosechIA", key: "field", kind: "data", title: "Registros append-only de campo", summary: "Bitácoras de labores, riego, agua, estimaciones y eventos adversos con trazabilidad.", source: "app/Http/Controllers/Vintner/BitacoraController.php; app/Http/Controllers/Vintner/RegistroCampoController.php", tags: ["field", "audit"] },
  { project: "CosechIA", key: "maturity", kind: "capability", title: "Maduración y cosecha", summary: "Lecturas e indicadores de madurez apoyan la comparación de bloques y recomendación de vendimia.", source: "app/Services/Vintner/MaturityService.php; app/Services/Agente/RecomendacionCosechaService.php", tags: ["maturity", "harvest"] },
  { project: "CosechIA", key: "winery", kind: "data", title: "Trazabilidad de bodega", summary: "Lotes de uva y vino se relacionan con recipientes, análisis y embotellados.", source: "app/Services/Vintner/HarvestService.php; app/Services/Vintner/BodegaOperacionService.php; app/Models/LoteUva.php; app/Models/LoteVino.php", tags: ["winery", "traceability"] },
  { project: "CosechIA", key: "knowledge", kind: "integration", title: "Manuales, fichas y búsqueda híbrida", summary: "Embeddings de manuales y fichas alimentan recuperación de conocimiento para el agente.", source: "app/Services/HybridRetriever.php; app/Services/EmbeddingStore.php; app/Models/FichaEmbedding.php; app/Models/ManualEmbedding.php", tags: ["rag", "embeddings"] },
  { project: "CosechIA", key: "agent", kind: "module", title: "Agente CosechIA", summary: "Herramientas para consultar bloques, clima, maduración, catálogos y documentación especializada.", source: "app/Agent/CosechIAAgent.php; app/Agent/Tools/", tags: ["agent", "tools"] },
  { project: "CosechIA", key: "decisions", kind: "capability", title: "Decisiones y memoria", summary: "Acciones sujetas a aprobación, auditoría de decisiones y versiones de memoria.", source: "app/Services/Agente/DecisionActionService.php; app/Services/Vintner/MemoryService.php", tags: ["approval", "audit"] },
  { project: "CosechIA", key: "atlas", kind: "function", title: "Atlas y análisis", summary: "Dashboards agregan indicadores y comparaciones de valles, viñedos y bloques.", source: "app/Services/Dashboard/AtlasService.php; app/Services/Dashboard/ComparadorService.php", tags: ["dashboard", "analytics"] },
  { project: "CosechIA", key: "simulation", kind: "capability", title: "Simulación vitícola y vinícola", summary: "Simula ciclos, clima, cosecha y bodega con replay y modo dry-run.", source: "app/Services/Simulation/SimulationService.php; docs/SIMULATION.md", tags: ["simulation", "replay"] },
  { project: "CosechIA", key: "database", kind: "data", title: "PostgreSQL y pgvector", summary: "Persistencia relacional y vectores con vistas analíticas vitícolas y vinícolas.", source: "database/migrations/; database/schema/; composer.json", tags: ["postgresql", "pgvector"] },
];
const relations = [
  ["Meido", "meido_movil", "parent_of", "La app móvil es el cliente Android del ecosistema Meido: comparte conversación, órdenes, aprobaciones, agentes y memoria."],
  ["Meido", "Mitpad", "parent_of", "Mitpad es el workbench de proyectos y agentes que Meido usa para organizar el trabajo y conservar contexto."],
  ["Meido", "CosechIA", "related_to", "Meido puede consultar y delegar trabajo de CosechIA mediante ProjectHub/MCP; son productos independientes."],
  ["Mitpad", "CosechIA", "related_to", "Mitpad organiza el trabajo de CosechIA y conecta el repositorio con sus funciones y datos técnicos."],
  ["meido_movil", "CosechIA", "related_to", "La app móvil puede supervisar trabajo de CosechIA mediante el flujo ProjectHub compartido."],
] as const;

export const listar = query({
  args: { token: v.string(), projectId: v.optional(v.id("projects")), kind: v.optional(kind) }, returns: v.array(output),
  handler: async (ctx, args) => {
    exigirToken(args.token);
    const workspace = await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal())).unique();
    if (!workspace) return [];
    const rows = await ctx.db.query("projectKnowledge").withIndex("by_workspaceId_and_projectId", (q) => q.eq("workspaceId", workspace._id)).take(1000);
    return rows.filter((item) => (!args.projectId || item.projectId === args.projectId) && (!args.kind || item.kind === args.kind)).map((item) => ({ id: item._id, projectId: item.projectId, kind: item.kind, title: item.title, summary: item.summary, source: item.source, tags: item.tags, updatedAt: item.updatedAt }));
  },
});

export const sembrarRepositorios = internalMutation({
  args: {}, returns: v.object({ projects: v.number(), knowledge: v.number(), relations: v.number() }),
  handler: async (ctx) => {
    const workspaceId = await asegurarWorkspace(ctx, userIdPersonal());
    return await seedCatalog(ctx, workspaceId);
  },
});

async function seedCatalog(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  const definitions = [
    ["Meido", "repo:meido", "Asistente multimodal de escritorio y móvil con voz, herramientas locales, memoria y coordinación de agentes."],
    ["meido_movil", "repo:meido_movil", "Cliente Android Flutter de Meido para chat, voz, agentes y continuidad con el escritorio."],
    ["Mitpad", "repo:mitpad", "Workbench para proyectos, tareas, agentes, notas, imágenes y mapa 3D de conocimiento."],
    ["CosechIA", "repo:cosechia", "Plataforma vitícola y vinícola con registros, trazabilidad, dashboards y agente agronómico."],
  ] as const;
  const found = await ctx.db.query("projects").withIndex("by_workspaceId_and_updatedAt", (q) => q.eq("workspaceId", workspaceId)).take(500);
  const byName = new Map(found.map((project) => [project.name.toLowerCase(), project]));
  const projectIds = new Map<string, Id<"projects">>();
  let projects = 0;
  const now = Date.now();
  for (const [name, clientId, description] of definitions) {
    let project = byName.get(name.toLowerCase());
    if (!project) {
      const id = await ctx.db.insert("projects", { workspaceId, clientId, name, description, status: "active", createdByType: "human", createdById: "pilot", createdAt: now, updatedAt: now });
      project = await ctx.db.get(id) ?? undefined;
      projects++;
    }
    if (!project) throw new ConvexError(`No se pudo preparar el proyecto ${name}.`);
    projectIds.set(name, project._id);
  }
  let knowledge = 0;
  for (const item of entries) {
    const projectId = projectIds.get(item.project);
    if (!projectId) continue;
    const clientId = `catalog:${item.project}:${item.key}`;
    const prior = await ctx.db.query("projectKnowledge").withIndex("by_workspaceId_and_clientId", (q) => q.eq("workspaceId", workspaceId).eq("clientId", clientId)).unique();
    const value = { workspaceId, projectId, clientId, kind: item.kind, title: item.title, summary: item.summary, source: item.source, tags: item.tags, updatedAt: now };
    if (prior) await ctx.db.patch(prior._id, value);
    else { await ctx.db.insert("projectKnowledge", value); knowledge++; }
  }
  let relationCount = 0;
  for (const [source, target, relationType, description] of relations) {
    const sourceProjectId = projectIds.get(source), targetProjectId = projectIds.get(target);
    if (!sourceProjectId || !targetProjectId) continue;
    const prior = await ctx.db.query("projectLinks").withIndex("by_sourceProjectId_and_targetProjectId", (q) => q.eq("sourceProjectId", sourceProjectId).eq("targetProjectId", targetProjectId)).unique();
    if (prior) await ctx.db.patch(prior._id, { relationType, description });
    else {
      await ctx.db.insert("projectLinks", { workspaceId, clientId: `repo-link:${source}:${target}`, sourceProjectId, targetProjectId, relationType, description, createdAt: now });
      relationCount++;
    }
  }
  return { projects, knowledge, relations: relationCount };
}
