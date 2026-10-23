<script lang="ts">
    import { onMount } from 'svelte';
    import {
        createLocalNote,
        updateLocalNote,
        deleteLocalNote,
        listLocalNotes,
        getSyncStatus,
        retryFailedSync,
        pullCloudNotes,
        type Note,
        type SyncStatus
    } from '$lib/ipc';
    import { USER_ID } from '$lib/config';

    let notes: Note[] = [];
    let activeNote: Note | null = null; // Controla si estamos editando o creando

    let title = '';
    let content = '';

    let errorMessage = '';
    let successMessage = '';
    let status: SyncStatus | null = null;
    let busy = false;

    onMount(() => {
        void refresh();
        // El worker sube en segundo plano: el estado se refresca solo.
        const temporizador = setInterval(() => {
            void refrescarEstado();
        }, 5000);
        return () => clearInterval(temporizador);
    });

    async function refrescarEstado() {
        try {
            status = await getSyncStatus();
        } catch {
            // Si falla la consulta no molestamos al usuario: se reintenta.
        }
    }

    async function refresh() {
        try {
            notes = await listLocalNotes();
            status = await getSyncStatus();
        } catch (error) {
            errorMessage = `Error al leer las notas: ${error}`;
        }
    }

    function abrir(nota: Note) {
        activeNote = nota;
        title = nota.title ?? '';
        content = nota.content;
        errorMessage = '';
        successMessage = '';
    }

    function handleNew() {
        activeNote = null;
        title = '';
        content = '';
        successMessage = '';
        errorMessage = '';
    }

    async function handleSave() {
        errorMessage = ''; successMessage = '';
        if (!content.trim()) {
            errorMessage = 'El contenido de la nota es obligatorio.';
            return;
        }

        busy = true;
        try {
            if (activeNote) {
                // MODO EDICIÓN
                const guardada = await updateLocalNote(activeNote.id, title, content);
                activeNote = guardada;
                successMessage = `✅ Nota actualizada. UUID: ${guardada.id}`;
            } else {
                // MODO CREACIÓN
                activeNote = await createLocalNote(title, content, USER_ID);
                successMessage = `✅ Nueva nota creada. UUID: ${activeNote.id}`;
            }
            await refresh();
        } catch (error) {
            errorMessage = `Error del sistema local: ${error}`;
        } finally {
            busy = false;
        }
    }

    async function handleDelete() {
        if (!activeNote) return;

        busy = true;
        try {
            await deleteLocalNote(activeNote.id);
            successMessage = `🗑️ Nota ${activeNote.id} borrada localmente y encolada.`;
            handleNew();
            await refresh();
        } catch (error) {
            errorMessage = `Error al borrar: ${error}`;
        } finally {
            busy = false;
        }
    }

    async function handlePull() {
        errorMessage = ''; successMessage = '';
        busy = true;
        try {
            notes = await pullCloudNotes(USER_ID);
            status = await getSyncStatus();
            successMessage = '☁️ Notas actualizadas desde la nube.';
        } catch (error) {
            errorMessage = `No se pudo traer de la nube: ${error}`;
        } finally {
            busy = false;
        }
    }

    async function handleRetry() {
        errorMessage = ''; successMessage = '';
        busy = true;
        try {
            const count = await retryFailedSync();
            status = await getSyncStatus();
            successMessage = count > 0
                ? `🔁 ${count} operación(es) devueltas a la cola.`
                : 'No había operaciones fallidas.';
        } catch (error) {
            errorMessage = `Error al reintentar: ${error}`;
        } finally {
            busy = false;
        }
    }

    function formato(fecha: number): string {
        return new Date(fecha).toLocaleString();
    }

    function resumen(nota: Note): string {
        const texto = nota.content.replace(/\s+/g, ' ').trim();
        return texto.length > 70 ? `${texto.slice(0, 70)}…` : texto;
    }
</script>

<main>
    <div class="header">
        <h1>Mitpad <span>Offline-First</span></h1>
        <div class="header-acciones">
            {#if status && status.configured}
                <button class="btn-cloud" on:click={handlePull} disabled={busy}>☁️ Traer de la nube</button>
            {/if}
            {#if status && status.failed > 0}
                <button class="btn-retry" on:click={handleRetry} disabled={busy}>🔁 Reintentar ({status.failed})</button>
            {/if}
            <button class="btn-new" on:click={handleNew} disabled={busy}>+ Nueva Nota</button>
        </div>
    </div>

    {#if status}
        <div class="sync" class:sync-error={status.failed > 0}>
            {#if !status.configured}
                Sin MITPAD_CONVEX_URL / MITPAD_TOKEN: las notas se quedan solo en este equipo.
            {:else if status.failed > 0}
                ⚠️ {status.failed} sincronización(es) fallida(s): {status.last_error ?? 'sin detalle'}
            {:else if status.pending > 0}
                ⏳ {status.pending} cambio(s) pendiente(s) de subir.
            {:else if status.last_sync_at}
                ✅ Al día. Última sincronización: {formato(status.last_sync_at)}
            {:else}
                ✅ Al día.
            {/if}
        </div>
    {/if}

    <div class="layout">
        <aside class="lista">
            {#if notes.length === 0}
                <p class="vacio">Todavía no hay notas en este equipo.</p>
            {:else}
                {#each notes as nota (nota.id)}
                    <button
                        class="nota"
                        class:activa={activeNote?.id === nota.id}
                        on:click={() => abrir(nota)}
                    >
                        <span class="nota-titulo">{nota.title ?? 'Sin título'}</span>
                        <span class="nota-resumen">{resumen(nota)}</span>
                        <span class="nota-pie">
                            {formato(nota.updated_at)}
                            {#if nota.synced_at === null}<span class="pendiente">⏳ pendiente</span>{/if}
                        </span>
                    </button>
                {/each}
            {/if}
        </aside>

        <section class="editor-container">
            {#if errorMessage}
                <div class="error">{errorMessage}</div>
            {/if}

            <input
                type="text"
                placeholder="Título de la nota (Opcional)"
                bind:value={title}
            />

            <textarea
                placeholder="Escribe tu idea aquí. Meido la analizará pronto..."
                bind:value={content}
            ></textarea>

            <div class="actions">
                <button class="btn-save" on:click={handleSave} disabled={busy}>
                    {activeNote ? 'Actualizar Localmente' : 'Guardar Localmente'}
                </button>

                {#if activeNote}
                    <button class="btn-delete" on:click={handleDelete} disabled={busy}>Borrar</button>
                {/if}
            </div>
        </section>
    </div>

    {#if successMessage}
        <div class="success-log">
            <p><strong>{successMessage}</strong></p>
            <p>Operación en <code>sync_queue</code> capturada por el Worker.</p>
        </div>
    {/if}
</main>

<style>
    :global(body) { background-color: #1e1e2e; color: #cdd6f4; font-family: system-ui, sans-serif; }
    main { max-width: 1100px; margin: 0 auto; padding: 2rem; }

    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 1rem; }
    .header-acciones { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    h1 { color: #89b4fa; margin: 0; }
    span { font-size: 0.5em; color: #a6adc8; vertical-align: middle; }

    .sync {
        padding: 0.6rem 1rem; margin-bottom: 1rem; border-radius: 8px;
        background-color: #313244; border-left: 4px solid #a6e3a1; font-size: 0.9rem;
    }
    .sync-error { border-left-color: #f38ba8; }

    .layout { display: grid; grid-template-columns: 280px 1fr; gap: 1rem; align-items: start; }

    .lista { display: flex; flex-direction: column; gap: 0.5rem; max-height: 70vh; overflow-y: auto; }
    .nota {
        display: flex; flex-direction: column; gap: 0.25rem; text-align: left;
        background-color: #313244; color: #cdd6f4; padding: 0.7rem 0.9rem;
        border: 1px solid #45475a; border-radius: 8px; cursor: pointer; flex: none;
    }
    .nota:hover { border-color: #89b4fa; }
    .nota.activa { border-color: #89b4fa; background-color: #3a3c52; }
    .nota-titulo { font-weight: bold; color: #89b4fa; font-size: 0.95rem; }
    .nota-resumen { font-size: 0.8rem; color: #a6adc8; }
    .nota-pie { font-size: 0.7rem; color: #6c7086; }
    .pendiente { color: #f9e2af; margin-left: 0.4rem; }
    .vacio { color: #6c7086; font-size: 0.85rem; }

    .editor-container { display: flex; flex-direction: column; gap: 1rem; }

    input, textarea {
        background-color: #313244; border: 1px solid #45475a; color: #cdd6f4;
        padding: 1rem; border-radius: 8px; font-size: 1rem;
    }
    textarea { height: 300px; resize: vertical; }
    input:focus, textarea:focus { outline: 2px solid #89b4fa; }

    .actions { display: flex; gap: 1rem; }

    button {
        padding: 1rem; border-radius: 8px; font-weight: bold; cursor: pointer;
        border: none; transition: 0.2s; flex: 1;
    }
    button:disabled { opacity: 0.6; cursor: default; }
    .btn-save { background-color: #89b4fa; color: #1e1e2e; }
    .btn-save:hover:not(:disabled) { background-color: #b4befe; }

    .btn-delete { background-color: #f38ba8; color: #1e1e2e; flex: 0.3; }
    .btn-delete:hover:not(:disabled) { background-color: #eba0ac; }

    .btn-new { background-color: transparent; color: #a6e3a1; border: 1px solid #a6e3a1; padding: 0.5rem 1rem; flex: none; }
    .btn-new:hover:not(:disabled) { background-color: rgba(166, 227, 161, 0.1); }

    .btn-cloud { background-color: transparent; color: #89b4fa; border: 1px solid #89b4fa; padding: 0.5rem 1rem; flex: none; }
    .btn-cloud:hover:not(:disabled) { background-color: rgba(137, 180, 250, 0.1); }

    .btn-retry { background-color: transparent; color: #f9e2af; border: 1px solid #f9e2af; padding: 0.5rem 1rem; flex: none; }
    .btn-retry:hover:not(:disabled) { background-color: rgba(249, 226, 175, 0.1); }

    .error { color: #f38ba8; padding: 1rem; border: 1px solid #f38ba8; border-radius: 8px; }
    .success-log { margin-top: 2rem; padding: 1rem; background-color: #313244; border-left: 4px solid #a6e3a1; border-radius: 4px; }
    code { background: rgba(0,0,0,0.3); padding: 0.2rem 0.4rem; border-radius: 4px; }
</style>
