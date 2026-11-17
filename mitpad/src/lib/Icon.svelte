<script lang="ts">
    // Small stroke icon set (24px grid, 1.6 stroke) so navigation does not depend on unicode glyphs.
    export let name: 'folder' | 'board' | 'memory' | 'image' | 'file' | 'activity' | 'agents' | 'key' | 'map';
    export let size = 18;

    const paths: Record<string, string> = {
        folder: 'M3 7a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
        board: 'M4 5h4.5v14H4zM9.75 5h4.5v9h-4.5zM15.5 5H20v6h-4.5z',
        memory: 'M7 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 7 20zM14.5 3.5V8H19M10 12h6M10 15.5h6',
        image: 'M4 5.5h16v13H4zM4 15.5l4.2-4.2 4 4 2.6-2.6L20 17M15.5 9.5h.01',
        file: 'M6 3.5h7.5L18 8v12.5H6zM13.5 3.5V8H18',
        activity: 'M3 12h4l2.5-6 4.5 12 2.5-6H21',
        agents: 'M5 8.5h14v9H5zM12 5v3.5M9 13h.01M15 13h.01M9.5 16h5',
        key: 'M14.5 9.5a4 4 0 1 1-1.2 2.8L4 21v-3l1.5-1.5H8V14l3.3-3.3A4 4 0 0 1 14.5 9.5zM16.5 8.5h.01',
        map: 'M12 4.5l7 4v7l-7 4-7-4v-7zM12 12.5l7-4M12 12.5v7M12 12.5l-7-4',
    };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>
