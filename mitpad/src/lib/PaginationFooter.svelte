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
        <span class="page-kicker">CARGADOS</span>
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
    .page-footer { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-top:16px; padding:14px 16px; border:1px solid #2b2f23; border-radius:6px; background:#151810; }
    .page-progress { display:grid; gap:3px; min-width:0; }
    .page-kicker { color:#7d7d6f; font-size:9px; font-weight:800; letter-spacing:1.2px; }
    .page-progress strong { color:#dfdccf; font-size:12px; }
    .page-help,.page-error { color:#777869; font-size:11px; line-height:1.4; }
    .page-error { color:#cf9477; }
    .page-more { display:inline-flex; flex:none; align-items:center; justify-content:center; gap:9px; min-height:38px; padding:0 14px; border:1px solid #3b3f31; border-radius:6px; background:#1f2318; color:#d3d0c2; font-size:11px; font-weight:700; cursor:pointer; transition:background .16s,border-color .16s; }
    .page-more:hover:not(:disabled) { border-color:#9aa57b; background:#22261a; }
    .page-more:disabled { opacity:.7; cursor:wait; }
    .arrow { font-size:15px; line-height:1; }
    .spinner { width:12px; height:12px; border:2px solid #5b5f48; border-top-color:#d3d0c2; border-radius:50%; animation:spin .7s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media(max-width:520px) { .page-footer { align-items:stretch; flex-direction:column; gap:12px; }.page-more { width:100%; } }
    @media(prefers-reduced-motion:reduce) { .page-more { transition:none; }.spinner { animation-duration:1.5s; } }
</style>
