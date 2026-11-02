# Mitpad

Mitpad es un workspace web para coordinar proyectos, tareas, notas, imágenes y agentes de IA. La landing pública está en `/`; el workspace privado se abre en `/app`.

## Qué puedes hacer

- Mantener proyectos, relaciones, tareas, responsables y actividad en un workspace privado.
- Editar tareas, cambiar su estado con arrastre o selección y conversar con los agentes desde cada tarea.
- Crear notas, asignarlas a proyectos, marcarlas como atendidas y adjuntar imágenes.
- Guardar imágenes de proyecto en Convex Storage.
- Subir archivos del workspace (PDF, documentos, hojas de cálculo, presentaciones, CSV y texto), buscarlos por nombre o etiqueta y vincularlos opcionalmente a un proyecto. Hay vistas previas locales para PDF y formatos de texto/Office compatibles; el límite actual es 25 MB por archivo y 1 GB por workspace.
- Crear, editar y desactivar agentes; cada agente MCP usa una credencial individual revocable.
- Explorar proyectos, tareas y conocimiento en el mapa 3D.
- Usar la web desde navegadores modernos sin instalar una aplicación local.

El código de la interfaz de escritorio anterior se conserva en `docs/archive/desktop-workbench-before-web-migration.svelte.txt` como referencia de la migración.

## Desarrollo local

Requisitos: Node.js 20 o posterior y pnpm.

```bash
corepack enable
pnpm install
pnpm dev
```

`pnpm run check` revisa Svelte y TypeScript. `pnpm run build` genera la versión estática para Render.

## Configuración de la web

Configura `PUBLIC_CONVEX_URL` en el entorno de build. El acceso web usa Convex Auth con correo y contraseña. En Convex configura el proveedor de autenticación y, si vas a enlazar un workspace anterior, `MITPAD_WEB_ALLOWED_EMAIL` junto con la verificación de correo.

La sesión de Convex Auth valida consultas y mutaciones. Cada cuenta tiene un workspace privado.

## MCP remoto

El servidor remoto usa Streamable HTTP en `https://mitpad.onrender.com/mcp`. Desde **Workspace → Agentes**, selecciona el cliente, crea una clave y usa **Probar conexión completa**. La prueba inicia MCP, enumera herramientas y consulta proyectos en modo lectura.

Para Codex, copia la configuración desde Mitpad y añádela a `~/.codex/config.toml`. También puedes escribirla así, sustituyendo el valor por la clave individual:

```toml
[mcp_servers.mitpad]
url = "https://mitpad.onrender.com/mcp"
http_headers = { Authorization = "Bearer pha_REEMPLAZAR_CON_TU_CLAVE" }
tool_timeout_sec = 60
```

No subas `config.toml` a Git: contiene la credencial. Después ejecuta `codex mcp list` y reinicia Codex para que cargue la conexión. En otros clientes, configura el mismo endpoint como Streamable HTTP y envía `Authorization: Bearer <clave>`.

No incluyas la clave del agente en chats, el repositorio ni los logs. El servicio usa `MITPAD_CONVEX_SITE_URL` y el puerto `PORT` de Render; `MITPAD_TOKEN` solo permanece en el backend y no se comparte con agentes.

El MCP remoto puede listar archivos, vincularlos a proyectos y subir documentos de texto/Markdown creados por el agente. Como el servicio remoto no puede leer el disco de tu equipo, para cargar un PDF, DOCX u otro archivo local original configura también el servidor stdio local:

```toml
[mcp_servers.mitpad_local_files]
command = "pnpm"
args = ["--dir", "/RUTA/AL/PROYECTO/mitpad", "run", "mcp"]
env = { MITPAD_CONVEX_SITE_URL = "https://brave-walrus-170.convex.site", MITPAD_AGENT_API_KEY = "pha_REEMPLAZAR_CON_TU_CLAVE", MITPAD_UPLOAD_ROOT = "/RUTA/DE/DOCUMENTOS" }
```

Reemplaza las rutas por las de tu equipo. `MITPAD_UPLOAD_ROOT` limita qué archivos puede leer el agente; el nombre de la ruta que envíes a `mitpad_files_upload_local` debe quedar dentro de esa carpeta. El agente debe consultar primero `mitpad_projects_list` y luego usar el ID exacto del proyecto al subir; el archivo queda asociado a ese proyecto al registrarse. Los archivos locales conservan sus bytes originales y tienen el mismo límite de 25 MB.

El proyecto también conserva la estructura Tauri anterior como fuente histórica, pero la aplicación mantenida y publicada es la web.
