import type { TestContext } from 'node:test';

import { createModelProject } from '../model-project.js';

export function tagsProject(t: TestContext, allowJs = false) {
  return createModelProject(t, {
    prefix: 'golem-model-tags-',
    name: 'model-tags',
    allowJs,
    linkWorkspaceNodeModules: true,
  });
}
