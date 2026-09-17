<script lang="ts">
    import { createLocalNote, updateLocalNote, deleteLocalNote, type Note } from '../../src-tauri/src/lib/core/ipc.ts';

    let title = '';
    let content = '';
    let activeNote: Note | null = null; // Controla si estamos editando o creando
    
    let errorMessage = '';
    let successMessage = '';

    const DEMO_USER_ID = 'f7c9a64f-efa2-4f29-8822-b1b6a1c2030c';

    async function handleSave() {
        errorMessage = ''; successMessage = '';
        if (!content.trim()) {
            errorMessage = 'El contenido de la nota es obligatorio.';
            return;
        }

        try {
            if (activeNote) {
                // MODO EDICIÓN
                await updateLocalNote(activeNote.id, title, content);
                activeNote.title = title;
                activeNote.content = content;
                successMessage = `✅ Nota actualizada. UUID: ${activeNote.id}`;
            } else {
                // MODO CREACIÓN
                activeNote = await createLocalNote(title, content, DEMO_USER_ID);
                successMessage = `✅ Nueva nota creada. UUID: ${activeNote.id}`;
            }
        } catch (error) {
            errorMessage = `Error del sistema local: ${error}`;
        }
    }

    async function handleDelete() {
        if (!activeNote) return;
        
        try {
            await deleteLocalNote(activeNote.id);
            successMessage = `🗑️ Nota ${activeNote.id} borrada localmente y encolada.`;
            
            // Limpiamos el editor
            activeNote = null;
            title = '';
            content = '';
        } catch (error) {
            errorMessage = `Error al borrar: ${error}`;
        }
    }

    function handleNew() {
        activeNote = null;
        title = '';
        content = '';
        successMessage = '';
        errorMessage = '';
    }
</script>

<main>
    <div class="header">
        <h1>Mitpad <span>Offline-First</span></h1>
        <button class="btn-new" on:click={handleNew}>+ Nueva Nota</button>
    </div>
    
    <div class="editor-container">
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
            <button class="btn-save" on:click={handleSave}>
                {activeNote ? 'Actualizar Localmente' : 'Guardar Localmente'}
            </button>
            
            {#if activeNote}
                <button class="btn-delete" on:click={handleDelete}>Borrar</button>
            {/if}
        </div>
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
    main { max-width: 800px; margin: 0 auto; padding: 2rem; }
    
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    h1 { color: #89b4fa; margin: 0; }
    span { font-size: 0.5em; color: #a6adc8; vertical-align: middle; }
    
    .editor-container { display: flex; flex-direction: column; gap: 1rem; }
    
    input, textarea {
        background-color: #313244; border: 1px solid #45475a; color: #cdd6f4;
        padding: 1rem; border-radius: 8px; font-size: 1rem;
    }
    textarea { height: 200px; resize: vertical; }
    input:focus, textarea:focus { outline: 2px solid #89b4fa; }
    
    .actions { display: flex; gap: 1rem; }
    
    button {
        padding: 1rem; border-radius: 8px; font-weight: bold; cursor: pointer;
        border: none; transition: 0.2s; flex: 1;
    }
    .btn-save { background-color: #89b4fa; color: #1e1e2e; }
    .btn-save:hover { background-color: #b4befe; }
    
    .btn-delete { background-color: #f38ba8; color: #1e1e2e; flex: 0.3; }
    .btn-delete:hover { background-color: #eba0ac; }
    
    .btn-new { background-color: transparent; color: #a6e3a1; border: 1px solid #a6e3a1; padding: 0.5rem 1rem; }
    .btn-new:hover { background-color: rgba(166, 227, 161, 0.1); }
    
    .error { color: #f38ba8; padding: 1rem; border: 1px solid #f38ba8; border-radius: 8px; }
    .success-log { margin-top: 2rem; padding: 1rem; background-color: #313244; border-left: 4px solid #a6e3a1; border-radius: 4px; }
    code { background: rgba(0,0,0,0.3); padding: 0.2rem 0.4rem; border-radius: 4px; }
</style>