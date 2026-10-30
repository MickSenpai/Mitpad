<script lang="ts">
    import { onMount } from 'svelte';
    import { ConvexHttpClient } from 'convex/browser';
    import { api } from '../../convex/_generated/api';
    import type { Id } from '../../convex/_generated/dataModel';

    export let client: ConvexHttpClient;
    type Vault = { id: Id<'privateVaults'>; salt: string; checkCiphertext: string; checkIv: string };
    type Entry = { id: Id<'privateVariables'>; name: string; service: string; description: string; value: string; createdAt: number; updatedAt: number; revealed: boolean };
    let phase: 'loading' | 'setup' | 'locked' | 'unlocked' | 'error' = 'loading';
    let vault: Vault | null = null;
    let key: CryptoKey | null = null;
    let entries: Entry[] = [];
    let passphrase = '', confirmation = '', name = '', service = '', description = '', value = '', editingId: Id<'privateVariables'> | null = null;
    let busy = false, error = '', notice = '', revealDraft = false, filterText = '';
    $: filteredEntries = entries.filter(entry => `${entry.name} ${entry.service} ${entry.description}`.toLowerCase().includes(filterText.trim().toLowerCase()));

    onMount(() => { void loadVault(); });

    async function loadVault() {
        phase = 'loading'; error = '';
        if (!globalThis.crypto?.subtle) { phase = 'error'; error = 'Este navegador no ofrece cifrado seguro. Abre Mitpad desde una conexión HTTPS actualizada.'; return; }
        try { vault = await client.query(api.privateVariables.getVault, {}); phase = vault ? 'locked' : 'setup'; }
        catch (reason) { phase = 'error'; error = `No se pudo abrir la caja privada: ${friendlyError(reason)}`; }
    }

    function encode(bytes: Uint8Array) {
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary);
    }
    function decode(value: string) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
    function randomBytes(length: number) { return crypto.getRandomValues(new Uint8Array(length)); }

    async function deriveKey(secret: string, salt: Uint8Array) {
        const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    async function encryptText(plainText: string, encryptionKey: CryptoKey) {
        const iv = randomBytes(12);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, new TextEncoder().encode(plainText));
        return { ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv) };
    }
    async function decryptText(ciphertext: string, iv: string, encryptionKey: CryptoKey) {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, encryptionKey, decode(ciphertext));
        return new TextDecoder().decode(plain);
    }

    async function createVault(event: SubmitEvent) {
        event.preventDefault();
        if (passphrase.length < 16) { error = 'Usa una frase maestra de al menos 16 caracteres.'; return; }
        if (passphrase !== confirmation) { error = 'Las frases maestras no coinciden.'; return; }
        busy = true; error = '';
        try {
            const salt = randomBytes(16), encryptionKey = await deriveKey(passphrase, salt);
            const check = await encryptText('mitpad-private-vault-check:v1', encryptionKey);
            vault = await client.mutation(api.privateVariables.createVault, { salt: encode(salt), checkCiphertext: check.ciphertext, checkIv: check.iv });
            if (vault.salt !== encode(salt)) { phase = 'locked'; passphrase = ''; error = 'La caja se creó en otra sesión. Desbloquéala con la frase maestra que usaste allí.'; return; }
            key = encryptionKey; passphrase = ''; confirmation = ''; phase = 'unlocked'; await loadEntries();
        } catch (reason) { error = `No se pudo configurar la caja: ${friendlyError(reason)}`; }
        finally { busy = false; }
    }

    async function unlock(event: SubmitEvent) {
        event.preventDefault(); if (!vault || !passphrase) return;
        busy = true; error = '';
        let encryptionKey: CryptoKey;
        try {
            encryptionKey = await deriveKey(passphrase, decode(vault.salt));
            const check = await decryptText(vault.checkCiphertext, vault.checkIv, encryptionKey);
            if (check !== 'mitpad-private-vault-check:v1') throw new Error('check');
        } catch { passphrase = ''; error = 'La frase maestra no es correcta o la caja está dañada. Inténtalo de nuevo.'; busy = false; return; }
        key = encryptionKey; passphrase = ''; phase = 'unlocked';
        try { await loadEntries(); } catch (reason) { error = `Caja desbloqueada, pero no se pudieron cargar las variables: ${friendlyError(reason)}`; }
        finally { busy = false; }
    }

    async function loadEntries() {
        if (!key) return;
        const encrypted = await client.query(api.privateVariables.list, {});
        entries = await Promise.all(encrypted.map(async row => {
            const record = JSON.parse(await decryptText(row.ciphertext, row.iv, key!)) as Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'revealed'>;
            return { ...record, id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, revealed: false };
        }));
    }

    function clearDraft() { name = ''; service = ''; description = ''; value = ''; editingId = null; revealDraft = false; }
    function editEntry(entry: Entry) { editingId = entry.id; name = entry.name; service = entry.service; description = entry.description; value = entry.value; error = ''; notice = ''; }
    async function saveEntry(event: SubmitEvent) {
        event.preventDefault(); if (!key) return;
        if (!name.trim() || !service.trim() || !value.trim()) { error = 'Completa el nombre, el servicio y el valor secreto.'; return; }
        if (name.length > 100 || service.length > 100 || description.length > 500 || value.length > 12_000) { error = 'Revisa los límites: nombre y servicio hasta 100 caracteres, nota hasta 500 y valor hasta 12 000.'; return; }
        busy = true; error = ''; notice = '';
        try {
            const encrypted = await encryptText(JSON.stringify({ name: name.trim(), service: service.trim(), description: description.trim(), value }), key);
            if (editingId) await client.mutation(api.privateVariables.update, { id: editingId, ...encrypted });
            else await client.mutation(api.privateVariables.create, encrypted);
            clearDraft(); await loadEntries(); notice = 'Variable privada guardada cifrada.';
        } catch (reason) { error = `No se pudo guardar: ${friendlyError(reason)}`; }
        finally { busy = false; }
    }
    async function removeEntry(entry: Entry) {
        if (!window.confirm(`¿Eliminar “${entry.name}” de la caja privada?`)) return;
        busy = true; error = ''; notice = '';
        try { await client.mutation(api.privateVariables.remove, { id: entry.id }); entries = entries.filter(item => item.id !== entry.id); if (editingId === entry.id) clearDraft(); notice = 'Variable eliminada.'; }
        catch (reason) { error = `No se pudo eliminar: ${friendlyError(reason)}`; }
        finally { busy = false; }
    }
    async function copyValue(entry: Entry) {
        try { await navigator.clipboard.writeText(entry.value); notice = `Se copió “${entry.name}”.`; }
        catch { error = 'El navegador bloqueó el portapapeles. Selecciona el valor para copiarlo manualmente.'; }
    }
    function lock() { key = null; entries = []; clearDraft(); phase = 'locked'; notice = ''; error = ''; }
    function friendlyError(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
</script>

<section class="vault-page">
    <header class="vault-heading"><div><div class="eyebrow">ALMACENAMIENTO PERSONAL</div><h2>Variables privadas</h2><p>Guarda API keys, tokens y accesos con un nombre fácil de reconocer.</p></div>{#if phase === 'unlocked'}<button class="lock-button" on:click={lock}>Bloquear caja</button>{/if}</header>
    {#if error}<div class="vault-message error" role="alert">{error}</div>{/if}{#if notice}<div class="vault-message notice" role="status">{notice}</div>{/if}
    {#if phase === 'loading'}<div class="vault-state">Preparando tu caja privada…</div>
    {:else if phase === 'error'}<div class="vault-state"><button class="secondary" on:click={() => void loadVault()}>Reintentar</button></div>
    {:else if phase === 'setup'}<form class="vault-lock-card" on:submit={createVault}><span class="vault-mark">⌑</span><h3>Crea tu frase maestra</h3><p>Esta frase cifra tus datos en este navegador. Mitpad no puede verla ni recuperarla si la pierdes.</p><label>Frase maestra<input type="password" bind:value={passphrase} minlength="16" autocomplete="new-password" required /></label><label>Confirma la frase<input type="password" bind:value={confirmation} minlength="16" autocomplete="new-password" required /></label><button class="primary" disabled={busy}>{busy ? 'Cifrando…' : 'Crear caja cifrada'}</button><small>Usa al menos 16 caracteres y guárdala en un lugar seguro, separada de tus API keys.</small></form>
    {:else if phase === 'locked'}<form class="vault-lock-card" on:submit={unlock}><span class="vault-mark">⌑</span><h3>Desbloquea tu caja</h3><p>La caja se bloquea al cerrar o refrescar esta página. Tu frase maestra solo vive en memoria mientras la usas.</p><label>Frase maestra<input type="password" bind:value={passphrase} autocomplete="current-password" required /></label><button class="primary" disabled={busy}>{busy ? 'Abriendo…' : 'Desbloquear'}</button></form>
    {:else}<div class="vault-content"><div class="vault-notice"><strong>El cifrado ocurre en este navegador</strong><span>Se cifra el nombre, el servicio, la nota y el valor antes de enviarlos a Convex. Esta caja no se comparte con agentes MCP.</span></div><form class="vault-form" on:submit={saveEntry}><div class="vault-form-heading"><div><strong>{editingId ? 'Editar variable' : 'Añadir una variable'}</strong><small>Ejemplo: “WhatsApp Cloud API” · “Producción”</small></div>{#if editingId}<button type="button" class="text-button" on:click={clearDraft}>Cancelar edición</button>{/if}</div><div class="vault-fields"><label>Nombre<input bind:value={name} maxlength="100" placeholder="WhatsApp Cloud API" required /></label><label>Servicio o entorno<input bind:value={service} maxlength="100" placeholder="Producción · Meta" required /></label><label class="secret-value">API key o token<div><input type={revealDraft ? 'text' : 'password'} bind:value={value} maxlength="12000" autocomplete="off" placeholder="Pega aquí el valor privado" required /><button type="button" class="reveal-button" on:click={() => revealDraft = !revealDraft}>{revealDraft ? 'Ocultar' : 'Mostrar'}</button></div></label><label class="vault-description">Nota privada<textarea bind:value={description} maxlength="500" rows="2" placeholder="Para qué cuenta o proyecto sirve"></textarea></label></div><button class="primary" disabled={busy}>{busy ? 'Cifrando…' : editingId ? 'Guardar cambios' : 'Guardar cifrada'}</button></form>
        <div class="vault-list-head"><div><strong>Tu caja</strong><span>{entries.length} {entries.length === 1 ? 'variable' : 'variables'}</span></div><small>Los valores se mantienen ocultos hasta que elijas mostrarlos.</small></div>
        {#if entries.length > 3}<label class="vault-search"><span>Buscar por nombre o servicio</span><input bind:value={filterText} placeholder="WhatsApp, producción…" /></label>{/if}
        {#if entries.length}<div class="vault-list">{#each filteredEntries as entry (entry.id)}<article class="vault-entry"><div class="vault-entry-main"><span class="key-glyph">⌘</span><div><strong>{entry.name}</strong><small>{entry.service}</small>{#if entry.description}<p>{entry.description}</p>{/if}<code>{entry.revealed ? entry.value : '••••••••••••••••••••'}</code></div></div><div class="vault-actions"><button on:click={() => entry.revealed = !entry.revealed}>{entry.revealed ? 'Ocultar' : 'Mostrar'}</button><button on:click={() => void copyValue(entry)}>Copiar</button><button on:click={() => editEntry(entry)}>Editar</button><button class="delete-action" on:click={() => void removeEntry(entry)} disabled={busy}>Eliminar</button></div></article>{/each}{#if filterText && !filteredEntries.length}<div class="vault-empty"><strong>No encontramos coincidencias</strong><span>Prueba con otro nombre o servicio.</span></div>{/if}</div>
        {:else}<div class="vault-empty"><strong>Aún no guardas variables</strong><span>Agrega tu primera API key y podrás encontrarla por nombre cuando la necesites.</span></div>{/if}
    </div>{/if}
</section>

<style>
    .vault-page{display:grid;gap:18px;max-width:1050px}.vault-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.vault-heading h2{margin:5px 0 4px;font:600 25px 'Bricolage Grotesque',Georgia,serif}.vault-heading p{margin:0;color:var(--muted);font-size:13px}.lock-button,.secondary{border:1px solid var(--line);border-radius:6px;padding:8px 11px;background:transparent;color:var(--muted);cursor:pointer}.vault-message{padding:11px 13px;border-radius:6px;font-size:13px}.vault-message.error{border:1px solid #70483a;background:#30231f;color:#e8ae98}.vault-message.notice{border:1px solid #4f6041;background:#252a20;color:#c7d4a6}.vault-state{padding:28px;text-align:center;color:var(--muted)}
    .vault-lock-card{display:grid;gap:13px;max-width:440px;margin:30px auto;padding:25px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}.vault-mark{display:grid;place-items:center;width:38px;height:38px;border:1px solid #665844;border-radius:10px;color:#e4b28d;font-size:22px}.vault-lock-card h3{margin:0;font:600 20px 'Bricolage Grotesque',Georgia,serif}.vault-lock-card p,.vault-lock-card small{margin:0;color:var(--muted);font-size:12px;line-height:1.6}.vault-lock-card label,.vault-fields label{display:grid;gap:6px;color:#d9d4c8;font-size:12px}.vault-lock-card input,.vault-fields input,.vault-fields textarea{width:100%;border:1px solid var(--line);border-radius:6px;background:#1a1d18;color:var(--text);padding:10px 11px}.vault-lock-card .primary,.vault-form>.primary{min-height:40px;border:0;border-radius:6px;background:var(--clay);color:#251b16;font-weight:650;cursor:pointer}.vault-lock-card .primary:disabled,.vault-form>.primary:disabled{opacity:.55}
    .vault-content{display:grid;gap:15px}.vault-notice{display:grid;gap:3px;padding:12px 14px;border:1px solid #47483c;border-radius:7px;background:#22251e}.vault-notice strong{font-size:12px;color:#e6e0d0}.vault-notice span{font-size:11px;color:var(--muted);line-height:1.5}.vault-form{display:grid;gap:14px;padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.vault-form-heading,.vault-list-head,.vault-entry{display:flex;align-items:center;justify-content:space-between;gap:14px}.vault-form-heading>div,.vault-list-head>div{display:grid;gap:3px}.vault-form-heading strong,.vault-list-head strong{font-size:14px}.vault-form-heading small,.vault-list-head span,.vault-list-head>small{font-size:11px;color:var(--muted)}.text-button{border:0;background:transparent;color:#dfab8b;font-size:12px;cursor:pointer}.vault-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.vault-fields .secret-value,.vault-fields .vault-description{grid-column:1/-1}.secret-value>div{display:flex;gap:7px}.reveal-button{border:1px solid var(--line);border-radius:6px;background:#2b2e24;color:var(--muted);padding:0 11px;cursor:pointer}.vault-fields textarea{resize:vertical}.vault-form>.primary{justify-self:start;padding:0 14px}.vault-list-head{padding-top:7px;border-top:1px solid var(--line)}.vault-search{display:grid;gap:5px;color:var(--muted);font-size:11px}.vault-search input{width:100%;max-width:400px;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:#1a1d18;color:var(--text)}.vault-list{display:grid;gap:8px}.vault-entry{align-items:flex-start;padding:13px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.vault-entry-main{display:flex;gap:11px;min-width:0}.key-glyph{display:grid;place-items:center;width:31px;height:31px;flex:none;border:1px solid #5b5040;border-radius:8px;color:#e1ad8a}.vault-entry-main>div{display:grid;gap:4px;min-width:0}.vault-entry-main strong{font-size:13px}.vault-entry-main small,.vault-entry-main p{margin:0;color:var(--muted);font-size:11px}.vault-entry-main code{max-width:100%;overflow-wrap:anywhere;color:#c5cfaa;font:11px ui-monospace,monospace}.vault-actions{display:flex;justify-content:flex-end;gap:5px;flex-wrap:wrap}.vault-actions button{border:1px solid var(--line);border-radius:5px;padding:5px 7px;background:#292c24;color:#cfccbf;font-size:10px;cursor:pointer}.vault-actions .delete-action{color:#dfa392}.vault-empty{display:grid;gap:5px;padding:28px;text-align:center;border:1px dashed #4a4d40;border-radius:8px;color:var(--muted);font-size:12px}.vault-empty strong{color:var(--text);font-size:14px}
    @media(max-width:680px){.vault-heading{flex-direction:column}.vault-fields{grid-template-columns:1fr}.vault-fields .secret-value,.vault-fields .vault-description{grid-column:auto}.vault-entry{flex-direction:column}.vault-actions{justify-content:flex-start}.vault-list-head{align-items:flex-start;flex-direction:column}}
</style>
