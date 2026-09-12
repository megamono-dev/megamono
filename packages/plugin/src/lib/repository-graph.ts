import type { ProjectGraph } from '@nx/devkit';

/** Installed dependency copies are not repository-owned Nx projects. */
export function repositoryOwnedGraph(graph: ProjectGraph): ProjectGraph {
  const nodes = Object.fromEntries(
    Object.entries(graph.nodes).filter(
      ([, node]) =>
        !node.data.root
          .replaceAll('\\', '/')
          .split('/')
          .some((part) => part === '.yalc' || part === 'node_modules'),
    ),
  );
  const excluded = new Set(
    Object.keys(graph.nodes).filter((name) => !nodes[name]),
  );
  return {
    ...graph,
    nodes,
    dependencies: Object.fromEntries(
      Object.entries(graph.dependencies)
        .filter(([name]) => !excluded.has(name))
        .map(([name, edges]) => [
          name,
          edges.filter((edge) => !excluded.has(edge.target)),
        ]),
    ),
  };
}
