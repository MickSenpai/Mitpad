# Mitpad

Mitpad es un workspace web para coordinar proyectos, tareas, notas, imágenes y agentes de IA. La landing pública está en `/`; el workspace privado se abre en `/app`.

## Qué puedes hacer

- Mantener proyectos, relaciones, tareas, responsables y actividad en un workspace privado.
- Editar tareas, cambiar su estado con arrastre o selección y conversar con los agentes desde cada tarea.
- Crear notas, asignarlas a proyectos, marcarlas como atendidas y adjuntar imágenes.
- Guardar imágenes de proyecto en Convex Storage.
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

Configura `PUBLIC_CONVEX_URL` y `VITE_CLERK_PUBLISHABLE_KEY` en el entorno de build. En Clerk, activa la integración con Convex y los métodos de acceso que quieras ofrecer. En Convex configura `CLERK_FRONTEND_API_URL` y, si el workspace legado lo requiere, `MITPAD_WEB_ALLOWED_EMAIL`. No incluyas la clave secreta de Clerk en el navegador.

La autenticación usa la sesión Clerk para validar consultas y mutaciones en Convex. Cada cuenta tiene un workspace privado.

## MCP remoto

El servidor remoto usa Streamable HTTP en `https://mitpad.onrender.com/mcp`. Para conectar un agente:

1. Abre **Agentes** en Mitpad y crea una credencial individual.
2. Guarda la clave en un archivo local privado; se muestra una sola vez.
3. Configura el cliente con la URL MCP y la cabecera `Authorization: Bearer <clave>`.
4. Comprueba la conexión con una lectura. Revoca la credencial desde Mitpad cuando deje de usarse.

No incluyas la clave del agente en chats, el repositorio ni los logs. El servicio usa `MITPAD_CONVEX_SITE_URL` y el puerto `PORT` de Render; `MITPAD_TOKEN` solo permanece en el backend y no se comparte con agentes.

El proyecto también conserva el transporte MCP local por stdio para desarrollo y la estructura Tauri anterior como fuente histórica, pero la aplicación mantenida y publicada es la web.
