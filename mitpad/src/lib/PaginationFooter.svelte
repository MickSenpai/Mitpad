<script lang="ts">
    export let label: string;
    export let count: number;
    export let help = 'Continúa para consultar los siguientes resultados.';
    export let loading = false;
    export let error = '';
    export let onLoadMore: () => void;
</script>

<section class="page-footer" aria-label={`Paginación de ${label}`}>
    <div class="page-progress" aria-live="polite">
        <span class="page-kicker">BIBLIOTECA</span>
        <strong>{count} {label} cargados</strong>
        <span class="page-help">{help}</span>
        {#if error}<span class="page-error" role="alert">{error}</span>{/if}
    </div>
    <button type="button" class="page-more" on:click={onLoadMore} disabled={loading}>
        {#if loading}<span class="spinner" aria-hidden="true"></span>Cargando
        {:else}Cargar 100 más <span class="arrow" aria-hidden="true">↓</span>{/if}
    </button>
</section>

<style>
    .page-footer { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-top:16px; padding:14px 16px; border:1px solid #393e32; border-radius:9px; background:linear-gradient(110deg,#20251f,#1b201c); }
    .page-progress { display:grid; gap:3px; min-width:0; }
    .page-kicker { color:#9bcbb8; font-size:9px; font-weight:800; letter-spacing:1.2px; }
    .page-progress strong { color:#e6e8db; font-size:12px; }
    .page-help,.page-error { color:#9ca397; font-size:11px; line-height:1.4; }
    .page-error { color:#e4a68a; }
    .page-more { display:inline-flex; flex:none; align-items:center; justify-content:center; gap:9px; min-height:38px; padding:0 14px; border:1px solid #587566; border-radius:7px; background:#293b32; color:#d0ebdb; font-size:11px; font-weight:700; cursor:pointer; transition:background .16s,border-color .16s,transform .16s; }
    .page-more:hover:not(:disabled) { transform:translateY(-1px); border-color:#8bcbb0; background:#31483a; }
    .page-more:disabled { opacity:.7; cursor:wait; }
    .arrow { font-size:15px; line-height:1; }
    .spinner { width:12px; height:12px; border:2px solid #789687; border-top-color:#e0f5e8; border-radius:50%; animation:spin .7s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media(max-width:520px) { .page-footer { align-items:stretch; flex-direction:column; gap:12px; }.page-more { width:100%; } }
    @media(prefers-reduced-motion:reduce) { .page-more { transition:none; }.spinner { animation-duration:1.5s; } }
</style>
