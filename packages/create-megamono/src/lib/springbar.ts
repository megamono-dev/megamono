import type { NormalizedCreateOptions } from './create-megamono.js';
import type { SpringbarSetupIntent } from '@megamono/cli/springbar';
export * from '@megamono/cli/springbar';

export function createSpringbarIntent(
  options: NormalizedCreateOptions,
  serviceVersions: Readonly<Record<string, string>>,
): SpringbarSetupIntent {
  const apps = options.appInstances.map((app) => ({
    app: app.type,
    name: app.name,
    projectName: `${options.scope}-${app.name}`,
    directory: app.directory,
  }));
  const backendApps = options.appInstances.filter(
    (app) => app.type === 'api' || app.type === 'worker',
  );
  const dependentApps = (
    backendApps.length > 0 ? backendApps : options.appInstances
  ).map((app) => app.name);
  const services = options.services.map((service) => {
    const registryName = service === 'postgres' ? 'postgresql' : service;
    const version = serviceVersions[registryName];
    if (!version)
      throw new Error(
        `No tested Springbar service version exists for ${service}.`,
      );
    return { service, version, dependentApps: [...dependentApps] };
  });
  return { workspaceRoot: options.destination, apps, services };
}
