import type { TestContext } from 'node:test';

import { createModelProject } from '../model-project.js';

export const modelProject = (t: Parameters<typeof createModelProject>[0]) => createModelProject(t, {
  prefix: 'golem-model-companions-',
  name: 'model-companions',
});

export function companionModelProject(t: TestContext, name: string) {
  return createModelProject(t, {
    prefix: `golem-${name}-`,
    name,
    linkWorkspaceNodeModules: true,
  });
}
