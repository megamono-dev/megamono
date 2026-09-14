import {
  createProjectGraphAsync,
  getProjects,
  type ProjectConfiguration,
  type ProjectGraph,
  type Tree,
} from '@nx/devkit';

/** Resolve inferred targets for validation; never persist graph-derived targets. */
export async function resolvedProjects(
  tree: Tree,
  loadGraph?: () => Promise<ProjectGraph>,
): Promise<Map<string, ProjectConfiguration>> {
  const explicit = getProjects(tree);
  // Nx's in-memory test trees have no on-disk workspace to infer. Tests can
  // supply a graph loader to exercise the production merge and failure paths.
  if (tree.root === '/virtual' && !loadGraph) return explicit;
  let graph: ProjectGraph;
  try {
    graph = await (
      loadGraph ?? (() => createProjectGraphAsync({ exitOnError: false }))
    )();
  } catch (cause) {
    throw new Error(
      'Cannot resolve the complete Nx project graph for target validation. Repair the graph before adoption.',
      { cause },
    );
  }
  const projects = new Map<string, ProjectConfiguration>();
  for (const [name, node] of Object.entries(graph.nodes)) {
    const root = node.data.root;
    if (
      root
        .split('/')
        .some((part) => ['node_modules', '.yalc', '..'].includes(part))
    )
      continue;
    if (root === '.' || tree.children(root).length)
      projects.set(name, node.data);
  }
  for (const [name, project] of explicit) {
    const inferred = graph.nodes[name]?.data;
    const targets = {
      ...(inferred?.root === project.root ? inferred.targets : {}),
    };
    for (const [target, configuration] of Object.entries(project.targets ?? {}))
      targets[target] = { ...targets[target], ...configuration };
    projects.set(name, { ...project, targets });
  }
  return projects;
}
