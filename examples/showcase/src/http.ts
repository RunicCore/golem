import { ProjectAccessClient } from '../sdk/index.js';
import { saveProjectAccess } from './save-access.js';
import type { ProjectAccessEditor } from './project-access.model.js';

export function saveProjectAccessOverHttp(
  baseUrl: string,
  projectId: string,
  access: ProjectAccessEditor,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  return saveProjectAccess(new ProjectAccessClient({ baseUrl, fetchImpl }), projectId, access);
}
