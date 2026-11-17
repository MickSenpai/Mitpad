<script lang="ts">
    import type { ConvexHttpClient } from 'convex/browser';
    import type { FunctionReturnType } from 'convex/server';
    import type { Id } from '../../convex/_generated/dataModel';
    import { api } from '../../convex/_generated/api';

    type Team = FunctionReturnType<typeof api.collaborators.equipo>;
    export let client: ConvexHttpClient;
    export let team: Team;
    /** Reload the team and the workspace data after something changed. */
    export let onChanged: () => Promise<void>;

    let busy = false, error = '', notice = '', joinCode = '', freshCode = '', freshExpires = 0;
    $: isOwner = team.current.role === 'owner';

    const when = (value: number) => new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(value);
    const text = (e: unknown) => (e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError:\s*/s, '').split('\n')[0] : String(e));

    async function run(action: () => Promise<void>, done = '') {
        if (busy) return;
        busy = true; error = ''; notice = '';
        try { await action(); await onChanged(); if (done) notice = done; }
        catch (e) { error = text(e); }
        finally { busy = false; }
    }
    const invite = () => run(async () => {
        const created = await client.mutation(api.collaborators.crearInvitacion, {});
        freshCode = created.code; freshExpires = created.expiresAt;
    });
    const revoke = (id: Id<'workspaceInvites'>) => run(async () => { await client.mutation(api.collaborators.revocarInvitacion, { inviteId: id }); freshCode = ''; }, 'Invitación revocada.');
    const remove = (member: Team['members'][number]) => {
        if (!window.confirm(`¿Quitar a ${member.email}? Dejará de ver este workspace de inmediato.`)) return;
        return run(async () => { await client.mutation(api.collaborators.quitarColaborador, { userId: member.userId }); }, 'Colaborador quitado.');
    };
    const leave = () => {
        if (!window.confirm(`¿Salir de «${team.current.name}»? Volverás a tu propio espacio.`)) return;
        return run(async () => { await client.mutation(api.collaborators.salirDelWorkspace, {}); }, 'Saliste del workspace.');
    };
    const join = () => run(async () => {
        const joined = await client.mutation(api.collaborators.aceptarInvitacion, { code: joinCode });
        joinCode = ''; notice = `Ahora colaboras en «${joined.name}».`;
    });
    async function copy() {
        try { await navigator.clipboard.writeText(freshCode); notice = 'Código copiado.'; }
        catch { error = 'El navegador no permitió copiarlo; selecciónalo y cópialo manualmente.'; }
    }
</script>

<section class="team">
    <div class="panel-head"><div><div class="eyebrow">COLABORACIÓN</div><h2>Equipo de «{team.current.name}»</h2></div><span class="role">{isOwner ? 'Propietario' : 'Colaborador'}</span></div>
    <p class="hint">Quien se une ve todos los proyectos, tareas, notas y archivos de este workspace y puede editarlos. Las claves privadas y la gestión del equipo son solo del propietario.</p>
    {#if error}<p class="msg err" role="alert">{error}</p>{/if}
    {#if notice}<p class="msg ok" role="status">{notice}</p>{/if}

    <div class="people">
        <div class="person"><span class="avatar">{(team.ownerEmail ?? '?').slice(0, 1).toUpperCase()}</span><div><strong>{team.ownerEmail ?? 'Propietario'}</strong><small>Propietario</small></div></div>
        {#each team.members as member (member.userId)}
            <div class="person"><span class="avatar">{member.email.slice(0, 1).toUpperCase()}</span><div><strong>{member.email}</strong><small>Colaborador desde {when(member.createdAt)}</small></div>
                {#if isOwner}<button class="danger" disabled={busy} on:click={() => void remove(member)}>Quitar</button>{/if}</div>
        {/each}
    </div>

    {#if isOwner}
        <div class="block">
            <div class="block-head"><strong>Invitar a alguien</strong><button class="primary-btn" disabled={busy} on:click={() => void invite()}>Crear código de invitación</button></div>
            <p class="hint">El código sirve una sola vez y vence en 7 días. Compártelo por un canal que controles; quien lo canjee entra como colaborador.</p>
            {#if freshCode}
                <div class="code-box"><code>{freshCode}</code><button class="ghost" on:click={() => void copy()}>Copiar</button></div>
                <small class="hint">Cópialo ahora: no se volverá a mostrar. Vence el {when(freshExpires)}.</small>
            {/if}
            {#if team.invites.length}
                <div class="invites">{#each team.invites as pending (pending.id)}
                    <div class="invite"><span>Invitación pendiente · creada el {when(pending.createdAt)} · vence el {when(pending.expiresAt)}</span><button class="danger" disabled={busy} on:click={() => void revoke(pending.id)}>Revocar</button></div>
                {/each}</div>
            {/if}
        </div>
    {:else}
        <div class="block"><div class="block-head"><strong>Salir de este workspace</strong><button class="danger" disabled={busy} on:click={() => void leave()}>Salir</button></div></div>
    {/if}

    <form class="block" on:submit|preventDefault={() => void join()}>
        <div class="block-head"><strong>Unirme a otro workspace</strong></div>
        <p class="hint">Pega el código que te compartió el propietario.</p>
        <div class="join"><input bind:value={joinCode} placeholder="pci_…" autocomplete="off" spellcheck="false" aria-label="Código de invitación" /><button class="primary-btn" disabled={busy || joinCode.trim().length < 20}>Unirme</button></div>
    </form>
</section>

<style>
    .team { display:grid; gap:16px; min-width:0; padding:22px; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:14px; }
    .panel-head h2 { margin:6px 0 0; font:600 17px/1.2 'Instrument Sans',system-ui,sans-serif; }
    .eyebrow { color:var(--quiet); font-size:10px; font-weight:700; letter-spacing:.1em; }
    .role { padding:2px 9px; border:1px solid #485238; border-radius:4px; color:var(--sage); font-size:11px; font-weight:600; }
    .hint { margin:0; color:var(--muted); font-size:13px; line-height:1.55; }
    .msg { margin:0; padding:10px 12px; border-radius:6px; font-size:13px; }
    .err { border:1px solid #5a3a2f; background:#231915; color:#d49f8a; }
    .ok { border:1px solid #485238; background:#1d2017; color:#bcc3a1; }
    .people { display:grid; border:1px solid var(--line); border-radius:6px; }
    .person { display:flex; align-items:center; gap:12px; padding:12px 14px; }
    .person+.person { border-top:1px solid var(--line); }
    .person>div { display:grid; flex:1; min-width:0; }
    .person strong { overflow:hidden; font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
    .person small { color:var(--quiet); font-size:11px; }
    .avatar { display:grid; width:30px; height:30px; flex:none; place-items:center; border:1px solid #3b3f31; border-radius:50%; background:#22261a; color:#c9a187; font-size:13px; font-weight:600; }
    .block { display:grid; gap:10px; padding-top:16px; border-top:1px solid var(--line); }
    .block-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .block-head strong { font-size:14px; }
    .primary-btn { min-height:36px; padding:7px 14px; border:0; border-radius:6px; background:var(--clay); color:#1a130f; font-weight:650; cursor:pointer; }
    .primary-btn:hover:not(:disabled) { background:#d29a7a; }
    .primary-btn:disabled,.danger:disabled,.ghost:disabled { opacity:.55; cursor:wait; }
    .ghost,.danger { min-height:32px; padding:5px 11px; border:1px solid #3b3f31; border-radius:6px; background:transparent; color:#d3d0c2; font-size:12px; cursor:pointer; }
    .danger { border-color:#5a3a2f; color:#cf9477; }
    .danger:hover:not(:disabled) { background:#2a1d18; }
    .ghost:hover:not(:disabled) { border-color:var(--sage); background:#1d2017; }
    .code-box { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid #55513a; border-radius:6px; background:#1a1d14; }
    .code-box code { flex:1; overflow-wrap:anywhere; color:#cbaa78; font:13px 'JetBrains Mono',ui-monospace,monospace; }
    .invites { display:grid; gap:6px; }
    .invite { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 12px; border:1px solid var(--line); border-radius:6px; color:var(--muted); font-size:12px; }
    .join { display:flex; gap:8px; }
    .join input { flex:1; min-width:0; padding:9px 11px; border:1px solid #3b3f31; border-radius:6px; background:#0c0f0a; color:var(--text); font:13px 'JetBrains Mono',ui-monospace,monospace; }
    @media (max-width:720px) { .team { padding:16px; } .block-head,.join { flex-direction:column; align-items:stretch; } }
</style>
