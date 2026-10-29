<script lang="ts">
    import { onMount } from 'svelte';
    import { ConvexHttpClient } from 'convex/browser';
    import { api } from '../../convex/_generated/api';

    export let client: ConvexHttpClient;
    export let email = '';
    export let onSignOut: () => void | Promise<void> = () => {};

    type Profile = { email: string | null; name: string | null; image: string | null };
    let profile: Profile = { email: null, name: null, image: null };
    let name = '';
    let loading = true;
    let saving = false;
    let error = '';
    let notice = '';

    onMount(() => { void load(); });

    async function load() {
        loading = true;
        try {
            profile = await client.query(api.auth.currentUser, {}) ?? { email: null, name: null, image: null };
            name = profile.name ?? '';
        } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason);
        } finally { loading = false; }
    }

    async function saveName() {
        saving = true; error = ''; notice = '';
        try {
            await client.mutation(api.auth.actualizarPerfil, { name });
            await load();
            notice = 'Tu perfil se guardó.';
        } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
        finally { saving = false; }
    }

    async function uploadPhoto(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
            error = 'Usa una foto JPEG, PNG o WebP de hasta 5 MB.'; input.value = ''; return;
        }
        saving = true; error = ''; notice = '';
        try {
            const url = await client.mutation(api.auth.crearUrlSubidaFotoPerfil, {});
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
            if (!response.ok) throw new Error(`No se pudo subir la foto (${response.status}).`);
            const { storageId } = await response.json();
            await client.mutation(api.auth.guardarFotoPerfil, { storageId });
            await load(); notice = 'Foto de perfil actualizada.';
        } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
        finally { saving = false; input.value = ''; }
    }
</script>

<div class="account-profile">
    {#if error}<p class="profile-message profile-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="profile-message profile-notice" role="status">{notice}</p>{/if}
    {#if loading}<div class="profile-loading">Cargando tu perfil…</div>{:else}
        <section class="profile-identity">
            {#if profile.image}<img class="profile-avatar" src={profile.image} alt="Foto de {profile.name || email}" />{:else}<div class="profile-avatar profile-initial">{(profile.name || email || 'M').slice(0, 1).toUpperCase()}</div>{/if}
            <div class="profile-identity-copy"><span class="profile-kicker">TU CUENTA</span><strong>{profile.name || 'Agrega tu nombre'}</strong><span>{profile.email || email}</span></div>
            <label class="profile-photo-button" class:disabled={saving}>Cambiar foto<input type="file" accept="image/jpeg,image/png,image/webp" on:change={uploadPhoto} disabled={saving} /></label>
        </section>
        <form class="profile-form" on:submit|preventDefault={saveName}>
            <label>Nombre visible<input bind:value={name} maxlength="80" placeholder="¿Cómo quieres aparecer?" required /></label>
            <label>Correo electrónico<input value={profile.email || email} readonly aria-readonly="true" /></label>
            <p class="profile-hint">El correo identifica tu cuenta y no se modifica desde este formulario.</p>
            <div class="profile-actions"><button class="profile-save" type="submit" disabled={saving || !name.trim()}>{saving ? 'Guardando…' : 'Guardar cambios'}</button><button class="profile-signout" type="button" on:click={() => void onSignOut()}>Cerrar sesión</button></div>
        </form>
    {/if}
</div>

<style>
    .account-profile{display:grid;gap:18px;padding:22px;color:#e6edf3}.profile-identity{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid #2d3a47;border-radius:12px;background:#151e27}.profile-avatar{width:68px;height:68px;flex:none;object-fit:cover;border-radius:50%;border:1px solid #40515e;background:#23323d}.profile-initial{display:grid;place-items:center;color:#a4f1dc;font-size:24px;font-weight:700}.profile-identity-copy{display:grid;gap:5px;min-width:0;flex:1}.profile-identity-copy strong{font-size:16px}.profile-identity-copy>span:last-child{color:#a5b3bf;font-size:12px;overflow-wrap:anywhere}.profile-kicker{color:#85b6a9;font-size:9px;font-weight:800;letter-spacing:1.3px}.profile-photo-button{position:relative;padding:9px 12px;border:1px solid #40524f;border-radius:7px;color:#b8e9dd;background:#1b2b2b;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap}.profile-photo-button input{position:absolute;width:1px;height:1px;opacity:0}.profile-photo-button.disabled{opacity:.55}.profile-form{display:grid;gap:14px}.profile-form label{display:grid;gap:7px;color:#b8c5d0;font-size:11px}.profile-form input{width:100%;padding:11px 12px;color:#edf3f6;background:#0c1218;border:1px solid #35424d;border-radius:7px}.profile-form input:focus{outline:2px solid #6bbba8;outline-offset:1px}.profile-form input[readonly]{color:#8f9daa;background:#121a22}.profile-hint{margin:-7px 0 0;color:#8493a1;font-size:10px;line-height:1.5}.profile-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;padding-top:5px}.profile-save,.profile-signout{padding:10px 14px;border:0;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer}.profile-save{color:#101917;background:#95e8d3}.profile-save:disabled{opacity:.55;cursor:wait}.profile-signout{color:#c3cdd5;background:#25303a}.profile-message{margin:0;padding:10px 12px;border-radius:7px;font-size:11px}.profile-error{color:#ffb9b1;background:#352124}.profile-notice{color:#a8ead8;background:#192d29}.profile-loading{padding:30px;text-align:center;color:#9baab6;font-size:12px}
    @media(max-width:580px){.account-profile{padding:14px}.profile-identity{align-items:flex-start;flex-wrap:wrap}.profile-identity-copy{min-width:calc(100% - 90px)}.profile-photo-button{margin-left:82px}.profile-actions{align-items:stretch;flex-direction:column-reverse}.profile-save,.profile-signout{width:100%}}
</style>
