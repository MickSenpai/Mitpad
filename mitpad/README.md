# Mitpad

App de notas **offline-first** para escritorio: Tauri 2 + SvelteKit 5 por delante,
SQLite local por dentro y [Convex](https://convex.dev) como nube. Las notas se
escriben primero en el disco y suben después; si no hay red, no se pierde nada.

```
┌──────────────┐   IPC (invoke)   ┌───────────────────────────┐
│  SvelteKit   │ ───────────────► │  Rust / Tauri             │
│  (interfaz)  │ ◄─────────────── │  ├─ SQLite local (notas)  │
└──────────────┘                  │  └─ worker de sincroniza- │
                                  │     ción → Convex          │
                                  └───────────────────────────┘
```

## Puesta en marcha

Requisitos: Node 20+, pnpm, Rust estable y las dependencias de sistema de Tauri
(en Linux: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`,
`patchelf`, `libssl-dev`).

```bash
pnpm install                 # dependencias del frontend
npx convex dev               # despliega el backend de Convex (opcional)
pnpm tauri dev               # arranca la app
```

Comandos habituales:

| Comando            | Qué hace                                        |
| ------------------ | ----------------------------------------------- |
| `pnpm dev`         | Solo el frontend (Vite)                         |
| `pnpm tauri dev`   | La app completa                                 |
| `pnpm tauri build` | Binario instalable                             |
| `pnpm check`       | `svelte-check` sobre TypeScript y Svelte       |
| `pnpm build`       | Compila el frontend a `build/`                 |
| `cargo test`       | Tests de Rust (en `src-tauri`)                 |
| `cargo clippy`     | Linter de Rust                                  |

## Configuración de la nube

El worker necesita dos datos: la URL del despliegue y el token de la app.
**Ninguno de los dos está en el código.** Se leen, en este orden, de:

1. las variables de entorno `MITPAD_CONVEX_URL` y `MITPAD_TOKEN`;
2. el archivo privado `~/.config/mitpad/convex_token.env` (permisos `600`):

```ini
MITPAD_CONVEX_URL=https://<despliegue>.convex.cloud
MITPAD_TOKEN=<el token del despliegue>
```

El token se define en Convex con `npx convex env set MITPAD_TOKEN <valor>` (y
`npx convex env set MITPAD_TOKEN --prod` para producción). Sin token la app
sigue funcionando: las notas se quedan en el equipo y la interfaz avisa de que
no hay nube configurada.

El id de usuario está en `src/lib/config.ts` (`USER_ID`).

## Cómo funciona la sincronización

1. Cada cambio (crear, editar, borrar) se escribe en SQLite **y** se anota en
   la tabla `sync_queue`, dentro de la misma transacción. Si la app se cierra a
   medias, no queda un cambio sin registrar.
2. La cola guarda **el estado final**, no la historia: como mucho hay una
   operación pendiente por nota. Editar una nota diez veces no genera diez
   subidas, sino una con el contenido final.
3. El worker (hilo aparte, cada 5 s) sube las operaciones pendientes a Convex.
   - `INSERT` si la nube todavía no conoce la nota, `UPDATE` si ya la conoce,
     `DELETE` si se borró.
   - Si la nube responde "la nota ya existe" o "la nota no existe", el worker
     reintenta con la otra operación para que app y nube convergieran.
4. Una operación que falla no bloquea a las demás: se anota el motivo y se
   reintenta hasta 5 veces. Pasado ese límite queda en estado `failed`, se ve
   en la interfaz y se puede reintentar con el botón 🔁 (o desaparece si la
   nota se borra, porque entonces ya no hay nada que subir).
5. `notes.synced_at` guarda la fecha que la nube confirmó. Por eso el worker
   sabe si una nota hay que crearla o editarla.

Al abrir la app se pueden traer las notas de otro equipo con **☁️ Traer de la
nube**: se fusionan con las locales y, si una nota local tiene cambios sin
subir, manda la local.

## Estructura

```
mitpad/
├── convex/                 Backend en Convex
│   ├── schema.ts           Tablas: users, notes, noteLinks
│   ├── notes.ts            Crear / actualizar / borrar / listar
│   ├── links.ts            Enlaces entre notas (tipo Obsidian)
│   ├── acceso.ts           Comprobación del token
│   └── convex.config.ts    Variables del despliegue
├── scripts/
│   └── migrar_neon_a_convex.py   Copia la base de datos de Neon a Convex
├── src/
│   ├── lib/ipc.ts          Puente con los comandos de Rust
│   ├── lib/config.ts       Id de usuario
│   └── routes/+page.svelte Interfaz (lista + editor + estado de sincronización)
└── src-tauri/src/
    ├── lib.rs              Punto de entrada: comandos y arranque
    ├── main.rs             Wrapper de `mitpad_lib::run()`
    ├── db/                 SQLite: esquema, migración y consultas
    └── sync/               config, worker (subida) y pull (bajada)
```

## Notas sobre el modelo

- Las fechas son **milisegundos desde 1970** en las tres capas (SQLite,
  Rust y Convex). Las bases de datos antiguas, con fechas en texto, se
  migran solas al arrancar.
- Convex no tiene usuarios: cada función comprueba el token de la app. Es un
  token compartido, válido para un uso personal; para varios usuarios habría
  que autenticación por usuario.
- La tabla `users` y los enlaces entre notas están en el esquema, pero la
  interfaz todavía no los usa.
