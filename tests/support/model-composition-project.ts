import type { TestContext } from 'node:test';

import { createModelProject } from '../model-project.js';

export function compositionProject(t: TestContext) {
  return createModelProject(t, {
    prefix: 'golem-model-composition-',
    name: 'model-composition',
    linkWorkspaceNodeModules: true,
  });
}
