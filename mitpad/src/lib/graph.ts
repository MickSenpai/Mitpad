// Pure builders for the 3D workspace map, kept out of the Svelte component so they can be tested.
export type KnowledgeKind = 'module' | 'function' | 'data' | 'capability' | 'integration' | 'decision';
export type GraphNode = {
    id: string; label: string; kind: 'project' | 'task' | 'knowledge'; projectId: string;
    x: number; y: number; z: number; status?: string; knowledgeKind?: KnowledgeKind;
    summary?: string; source?: string; tags?: string[];
};
export type RelationType = 'related_to' | 'parent_of' | 'depends_on';
export type GraphLink = { source_project_id: string; target_project_id: string; relation_type?: RelationType; description?: string };

type ProjectRow = { id: string; name: string };
type TaskRow = { id: string; projectId: string; title: string; status: string };
type KnowledgeRow = { id: string; projectId: string; title: string; kind: KnowledgeKind; summary: string; source: string; tags: string[] };
type LinkRow = { sourceProjectId: string; targetProjectId: string; relationType?: RelationType; description?: string };

const GOLDEN_ANGLE = 2.399963;

export function buildGraphNodes(
    projects: ProjectRow[], tasks: TaskRow[], knowledge: KnowledgeRow[], selectedProject: string,
): GraphNode[] {
    const visibleProjects = projects.filter(p => !selectedProject || p.id === selectedProject);
    const overviewRadius = Math.max(360, visibleProjects.length * 135);
    const angleFor = (i: number, offset = 0) => i * GOLDEN_ANGLE + offset;
    const projectNodes: GraphNode[] = visibleProjects.map((p, i) => {
        const angle = selectedProject ? 0 : -Math.PI / 2 + (i / Math.max(visibleProjects.length, 1)) * Math.PI * 2;
        const x = selectedProject ? 0 : Math.cos(angle) * overviewRadius;
        const z = selectedProject ? 0 : Math.sin(angle) * overviewRadius;
        return { id: p.id, label: p.name, kind: 'project', projectId: p.id, x, y: 0, z };
    });
    if (!selectedProject || !visibleProjects.length) return projectNodes;
    const projectId = visibleProjects[0].id;
    const taskNodes: GraphNode[] = tasks.filter(t => t.projectId === projectId).map((t, i) => {
        const angle = angleFor(i);
        const radius = 105 + Math.floor(i / 12) * 28;
        return { id: `task:${t.id}`, label: t.title, kind: 'task', projectId, x: Math.cos(angle) * radius, y: 34 + (i % 5 - 2) * 20, z: Math.sin(angle) * radius, status: t.status };
    });
    const knowledgeNodes: GraphNode[] = knowledge.filter(k => k.projectId === projectId).map((k, i) => {
        const angle = angleFor(i, 0.8);
        const radius = 205 + Math.floor(i / 16) * 32;
        return { id: `knowledge:${k.id}`, label: k.title, kind: 'knowledge', projectId, x: Math.cos(angle) * radius, y: -34 + (i % 5 - 2) * 20, z: Math.sin(angle) * radius, knowledgeKind: k.kind, summary: k.summary, source: k.source, tags: k.tags };
    });
    return [...projectNodes, ...taskNodes, ...knowledgeNodes];
}

export function buildGraphLinks(projectLinks: LinkRow[]): GraphLink[] {
    return projectLinks.map(link => ({ source_project_id: link.sourceProjectId, target_project_id: link.targetProjectId, relation_type: link.relationType, description: link.description }));
}
