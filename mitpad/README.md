# Mitpad

Mitpad is a local-first agent workbench for desktop, built with Tauri, SvelteKit, SQLite and Convex. It gives a human pilot and AI agents a shared model for projects, tasks, discussion, durable activity and reference notes.

## Current capabilities

- Projects and task board with backlog, to do, in progress, review, blocked and done states.
- Drag tasks between board columns to update their status, and assign active local agents to tasks.
- A workspace graph connects projects with their tasks for a visual overview.
- Task priorities, due dates, typed comments and an append-only local activity feed.
- Editable local agent directory with reversible deactivation. A primary Meido identity is created for assignment and coordination.
- Notes can be marked as attended and remain available; the desktop UI does not offer note deletion.
- Persistent notes and image attachments. Images stay in SQLite for offline access and synchronize through Convex Storage. Each image is limited to 10 MB; each note allows up to 200 images and 50 MB total.
- A project image library for uploading, previewing and deleting visual references independently of notes. Desktop and web images synchronize through Convex Storage, with the same 10 MB per-file, 200-image and 50 MB per-project limits.
- Existing note synchronization with Convex remains available through the background worker.
- Convex data model and a REST API for registering agents and letting them read or update projects, tasks, notes, comments and events.

## Run locally

Requirements: Node 20+, Rust, and Tauri system libraries. On Linux, install the WebKitGTK 4.1 and other Tauri build dependencies for your distribution.

```bash
corepack enable
pnpm install
pnpm run tauri dev
```

`pnpm dev` starts the web version. `pnpm check` checks the Svelte and TypeScript UI. `pnpm build` builds the frontend. Native Tauri builds also require the system libraries above.

## Web workspace authentication

The web workbench uses Clerk for sign-in and Clerk's Convex integration for session JWT validation. It no longer asks the browser for the private desktop app token. Set `PUBLIC_CONVEX_URL` and `VITE_CLERK_PUBLISHABLE_KEY` in the web build environment. In Clerk Dashboard, activate the Convex integration and enable GitHub under social login providers. Then set `CLERK_FRONTEND_API_URL` and `MITPAD_WEB_ALLOWED_EMAIL` in the selected Convex deployment. The allowed email is the single account permitted to view and edit this personal workspace; leave it unset to fail closed. Do not put a Clerk secret key in browser configuration.

### Continue on another computer

Clone this repository and check out the branch you want to continue (`fix/cola-sincronizacion-y-camino-de-lectura` contains the current work). Install the pinned package manager and dependencies with `corepack enable` and `pnpm install`. For Clerk development keys, authenticate the Clerk CLI, link the existing app, and pull only its development keys:

```bash
npx -y clerk@latest auth login
npx -y clerk@latest link --app app_3LIRZ8bCVaKVmNjgAVWONgL34vm
npx -y clerk@latest env pull --app app_3LIRZ8bCVaKVmNjgAVWONgL34vm --instance dev
```

Set `PUBLIC_CONVEX_URL=https://giddy-hedgehog-472.convex.cloud`, then log in to Convex and select that existing development deployment before running `npx convex dev`. The Clerk issuer and allowed account are already configured on that remote dev deployment. Desktop sync also needs `MITPAD_CONVEX_URL` and `MITPAD_TOKEN` in the private local config file `~/.config/mitpad/convex_token.env`; transfer those through a password manager or another private channel, never through GitHub. Production credentials are not part of this setup.

The web dashboard supports task and agent filters, project creation, task updates, persistent notes (including attended status and project assignment), and project-linked image uploads. Its read refresh runs every five minutes while the tab is visible; mutations are written immediately.

## Convex setup

The Convex backend is optional for local notes and workbench data. Configure `MITPAD_CONVEX_URL` and `MITPAD_TOKEN` either in the environment or in `~/.config/mitpad/convex_token.env` (make that file private). The existing note worker uses the Convex deployment URL and app token. To enable the new agent API and cloud image storage, deploy the Convex schema and functions, then set the app token as the Convex `MITPAD_TOKEN` environment variable.

Agent API routes use `/api/v1/` on the Convex site URL. The pilot registers an agent and receives its API key once; the backend stores only the key hash. Agents authenticate with `Authorization: Bearer <api_key>`. Available routes include:

- `GET|POST /api/v1/projects`
- `PATCH /api/v1/projects/:id`
- `GET|POST /api/v1/project-links`
- `GET /api/v1/knowledge?project_id=<id>&kind=<kind>`
- `GET|POST /api/v1/notes`
- `PATCH /api/v1/notes/:id` (including project assignment and attended status)
- `GET|POST /api/v1/tasks`
- `PATCH /api/v1/tasks/:id`
- `GET|POST /api/v1/tasks/:id/comments`
- `GET /api/v1/events?since=<epoch_ms>`

Keep agent API keys private. Do not commit the Convex token or credentials. The local Meido entry is an assignable identity, not a running model or an MCP connection; an external agent runtime still needs its own registered API key.

## Data storage

Notes, workbench records, activity and attached image bytes are stored in Mitpad's local SQLite database. Notes use the offline-first Convex synchronization queue. Images attached to notes and projects retain a local copy and synchronize to Convex Storage when the desktop is authenticated. The desktop also downloads web images for offline access; the local ID prevents duplicate uploads on later syncs. Project images stay associated with their selected project.

## MCP remoto y local

El MCP ofrece herramientas para proyectos, relaciones, conocimiento, tareas, notas, comentarios y actividad. El transporte local `stdio` sigue disponible; además, el Blueprint de Render define un servicio web separado con Streamable HTTP stateless en `/mcp`. Cada solicitud remota debe llevar la clave individual de un agente en `Authorization: Bearer ...`; Render no recibe el token maestro `MITPAD_TOKEN`.

Para conectar un agente de una cuenta web:

1. Despliega o sincroniza el Blueprint de Render. El servicio `mitpad-mcp` usa `MITPAD_CONVEX_SITE_URL` y el puerto `PORT` que Render proporciona. Su URL MCP queda en `https://mitpad-mcp.onrender.com/mcp` (si Render asigna otro hostname, usa ese).
2. En Mitpad web, abre **Agentes**, crea una clave MCP para ese agente y cópiala. Mitpad solo guarda el hash; si se pierde, revoca esa clave y crea otra.
3. En OpenCode, configura el MCP remoto y guarda la clave en el entorno privado desde el que arranca:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mitpad": {
      "type": "remote",
      "url": "https://mitpad-mcp.onrender.com/mcp",
      "headers": { "Authorization": "Bearer {env:MITPAD_AGENT_API_KEY}" },
      "enabled": true
    }
  }
}
```

Define `MITPAD_AGENT_API_KEY` como variable de entorno. No la guardes en el repositorio ni uses `MITPAD_TOKEN` como credencial del MCP. El servicio incluye `/healthz`, restringe hosts y rechaza orígenes de navegador no configurados. Si un cliente MCP corre en un navegador, configura `MITPAD_MCP_ALLOWED_ORIGINS` con sus orígenes exactos en Render.

Para el transporte local, define `MITPAD_CONVEX_SITE_URL` y `MITPAD_AGENT_API_KEY`, y ejecuta `pnpm run mcp`; el proceso usa stdio y nunca escribe logs en stdout.

## Windows installers

`.github/workflows/windows.yml` builds NSIS `.exe` and WiX `.msi` installers on a Windows runner when manually dispatched or when a `v*` tag is pushed. Configure the public GitHub Actions variables `PUBLIC_CONVEX_URL` and `VITE_CLERK_PUBLISHABLE_KEY` before running it. The workflow uploads installers as an artifact. Public distribution still needs a Windows code-signing certificate and production Clerk/Convex configuration; the workflow does not sign or publish releases.
