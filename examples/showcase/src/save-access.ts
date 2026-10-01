// #region api-operations
import { toWireFormat } from '@exprtlabs/golem/serde';
import type { ProjectAccessClientPort } from '../sdk/index.js';
import type { ProjectAccessEditor, TProjectAccessEditor } from './project-access.model.js';
import type { TProjectAccessEditorJSON } from './project-access.model.generated.js';

export async function saveProjectAccess(
  client: ProjectAccessClientPort,
  projectId: string,
  access: ProjectAccessEditor,
) {
  const updateAccess = client.updateProjectAccess();
  const body: TProjectAccessEditorJSON = toWireFormat<TProjectAccessEditor>(access);
  return updateAccess.execute({ path: { projectId }, body });
}
// #endregion api-operations
