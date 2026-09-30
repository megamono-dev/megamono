import type { ProjectGraph } from '@nx/devkit';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { MegamonoConfig } from './config';
import type { HealthFinding } from './health';

interface Service {
  name: string;
  rootDir: string;
  buildCommand: string | null;
  preDeployCommand: string | null;
}

// Deliberately bounded static evidence: arbitrary shell/scripts must be reviewed,
// not executed by a health check or accepted merely for mentioning "prisma".
function commands(source: string | null): string[][] {
  if (!source || /[;|`$\n]/.test(source)) return [];
  return source.split('&&').flatMap((part) => {
    const tokens =
      part
        .trim()
        .match(/'[^']*'|"[^"]*"|[^\s]+/g)
        ?.map((value) => value.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
    const prefix =
      tokens[0] === 'npm' && tokens[1] === 'exec'
        ? 2
        : tokens[0] === 'pnpm' && tokens[1] === 'exec'
          ? 2
          : tokens[0] === 'yarn' && tokens[1] === 'exec'
            ? 2
            : tokens[0] === 'bun' && tokens[1] === 'run'
              ? 2
              : tokens[0] === 'npx' || tokens[0] === 'yarn'
                ? 1
                : 0;
    const args = tokens.slice(prefix);
    if (args[0] === '--') args.shift();
    return args.length ? [args] : [];
  });
}

export function renderPrismaFindings(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const dependencies = (project: string) =>
    (graph.dependencies[project] ?? [])
      .map(({ target }) => target)
      .filter((name) => graph.nodes[name]);
  function closure(project: string, seen = new Set<string>()): Set<string> {
    if (seen.has(project)) return seen;
    seen.add(project);
    for (const name of dependencies(project)) closure(name, seen);
    return seen;
  }
  for (const [project, node] of Object.entries(graph.nodes)) {
    const metadata = node.data.metadata?.['megamono:render'] as
      { blueprintPath?: string; services?: Service[] } | undefined;
    if (!Array.isArray(metadata?.services)) continue;
    const reachable = closure(project);
    const databases = Object.entries(config.databases).filter(
      ([, database]) =>
        database.adapter === 'prisma' && reachable.has(database.project),
    );
    for (const [name, database] of databases) {
      const dbRoot = graph.nodes[database.project]?.data.root;
      if (!dbRoot) continue;
      const schema = database.schema;
      const configFile = [
        `${dbRoot}/prisma.config.ts`,
        'prisma.config.ts',
      ].find((path) => existsSync(resolve(workspaceRoot, path)));
      const configuredSchema = configFile
        ? readFileSync(resolve(workspaceRoot, configFile), 'utf8').match(
            /\bschema\s*:\s*['"]([^'"]+)['"]/,
          )?.[1]
        : undefined;
      const configuredFolder =
        schema?.endsWith('/schema.prisma') &&
        configFile &&
        configuredSchema &&
        resolve(workspaceRoot, dirname(configFile), configuredSchema) ===
          resolve(workspaceRoot, dirname(schema))
          ? resolve(workspaceRoot, dirname(schema))
          : undefined;
      function prismaCommand(
        source: string | null,
        cwd: string,
        kind: 'generate' | 'migrate',
      ): boolean {
        if (!schema) return false;
        return commands(source).some((args) => {
          if (
            args.some((arg) =>
              ['--help', '-h', '--version', '-v', '--dry-run'].includes(arg),
            )
          )
            return false;
          for (const flag of ['--schema', '--config']) {
            if (
              args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
                .length > 1
            )
              return false;
          }
          if (
            args[0] !== 'prisma' ||
            args[1] !== kind ||
            (kind === 'migrate' && args[2] !== 'deploy')
          )
            return false;
          const value = (flag: string) =>
            args
              .find((arg) => arg.startsWith(`${flag}=`))
              ?.slice(flag.length + 1) ?? args[args.indexOf(flag) + 1];
          if (
            !args.some(
              (arg) => arg === '--schema' || arg.startsWith('--schema='),
            )
          )
            return false;
          const declared = resolve(workspaceRoot, cwd, value('--schema') ?? '');
          const expected = configuredFolder ?? resolve(workspaceRoot, schema);
          if (
            declared !== expected &&
            !(
              !configuredFolder &&
              schema.endsWith('/schema.prisma') &&
              declared === dirname(expected)
            )
          )
            return false;
          // Project-local generation finds its config via cwd; root-level migrations
          // must explicitly select the database's config for Prisma 7.
          if (
            configFile &&
            !(
              kind === 'generate' &&
              resolve(workspaceRoot, cwd) ===
                resolve(workspaceRoot, dirname(configFile))
            )
          ) {
            if (
              !args.some(
                (arg) => arg === '--config' || arg.startsWith('--config='),
              )
            )
              return false;
            if (
              resolve(workspaceRoot, cwd, value('--config') ?? '') !==
              resolve(workspaceRoot, configFile)
            )
              return false;
          }
          return true;
        });
      }
      function targetGenerates(
        owner: string,
        targetName: string,
        seen = new Set<string>(),
      ): boolean {
        const id = `${owner}:${targetName}`;
        if (seen.has(id)) return false;
        seen.add(id);
        const target = graph.nodes[owner]?.data.targets?.[targetName];
        if (!target) return false;
        const options = target.options ?? {};
        const cwd = String(options.cwd ?? '.')
          .replace('{workspaceRoot}', '.')
          .replace('{projectRoot}', graph.nodes[owner].data.root);
        const source = target.command ?? options.command;
        if (
          typeof source === 'string' &&
          prismaCommand(source, cwd, 'generate')
        )
          return true;
        return (target.dependsOn ?? []).some((entry) => {
          if (typeof entry === 'string')
            return entry.startsWith('^')
              ? dependencies(owner).some((dep) =>
                  targetGenerates(dep, entry.slice(1), seen),
                )
              : targetGenerates(owner, entry, seen);
          const owners = Array.isArray(entry.projects)
            ? entry.projects
            : entry.dependencies
              ? dependencies(owner)
              : [owner];
          return owners.some((dep) => targetGenerates(dep, entry.target, seen));
        });
      }
      for (const service of metadata.services) {
        const cwd = service.rootDir || '.';
        const evidence = [
          metadata.blueprintPath ?? 'render.yaml',
          `Nx project: ${project}`,
          `Prisma database: ${name}`,
          ...(schema ? [schema] : []),
        ];
        const add = (
          code: string,
          summary: string,
          recommendation: string,
          confidence: 'complete' | 'reduced' = 'complete',
        ) =>
          findings.push({
            check: 'spec-drift',
            fingerprint: `render:prisma-${code}:${project}:${service.name}:${name}`,
            state: 'constrained',
            confidence,
            summary,
            evidence,
            recommendation,
          });
        if (
          cwd !== '.' &&
          (!schema?.startsWith(`${cwd}/`) || !dbRoot.startsWith(`${cwd}/`))
        )
          add(
            'root',
            `${service.name} excludes shared Prisma inputs from its Render root.`,
            'Review rootDir; build from the workspace root when the service needs sibling libraries, config, or migrations.',
          );
        const buildRunsNx = commands(service.buildCommand).some((args) => {
          if (
            args[0] !== 'nx' ||
            args.some(
              (arg) =>
                /excludeTaskDependencies/.test(arg) ||
                ['--help', '-h', '--version', '-v'].includes(arg),
            )
          )
            return false;
          const target =
            args[1] === 'run' ? args[2]?.split(':') : [args[2], args[1]];
          return (
            target?.[0] === project &&
            target[1] === 'build' &&
            targetGenerates(project, 'build')
          );
        });
        const directGeneration = service.buildCommand
          ?.split('&&')
          .some(
            (part, index, parts) =>
              prismaCommand(part, cwd, 'generate') &&
              parts
                .slice(0, index)
                .every((prefix) =>
                  /^(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install|bun\s+install)(?:\s|$)/.test(
                    prefix.trim(),
                  ),
                ),
          );
        if (!directGeneration && !buildRunsNx)
          add(
            'generate',
            `${service.name} has no verified build-time Prisma client generation for ${name}.`,
            'Add the database generate target to the API build dependencies and invoke that Nx build in buildCommand, or use an explicit schema-specific Prisma generate command. Custom wrappers need separate qualification.',
            service.buildCommand ? 'reduced' : 'complete',
          );
        if (!prismaCommand(service.preDeployCommand, cwd, 'migrate'))
          add(
            'migrate',
            `${service.name} has no verified pre-deploy Prisma migration step for ${name}.`,
            'Review and commit migrations, confirm backups and release approval, then set preDeployCommand to prisma migrate deploy with the database schema and config. Preserve the CLI/config/migrations in the deployment artifact; custom wrappers need separate qualification.',
            service.preDeployCommand ? 'reduced' : 'complete',
          );
      }
    }
  }
  return findings;
}
