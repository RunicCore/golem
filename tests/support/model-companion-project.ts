import type { FixtureScope } from '../fixture-project.js';
import { createModelProject } from '../model-project.js';

export const modelProject = (t: Parameters<typeof createModelProject>[0]) => createModelProject(t, {
  prefix: 'golem-model-companions-',
  name: 'model-companions',
});

export function companionModelProject(t: FixtureScope, name: string) {
  return createModelProject(t, {
    prefix: `golem-${name}-`,
    name,
    linkWorkspaceNodeModules: true,
  });
}
