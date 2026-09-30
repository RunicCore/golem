// #region home-example
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { ProjectAccessEditor } from './project-access.model.js';
import type { ProjectAccessEditorJSON } from './project-access.model.generated.js';

export function editAccess() {
  const access = fromWireFormat<ProjectAccessEditor>({
    projectName: 'Release Operations',
    member: { id: 'member-7', name: 'Mina Chen', email: 'mina@example.com' },
    permissions: '0x1', // Becomes the number 1.
  });
  const before = access.canWrite();
  const modelBefore = access.permissions;
  access.grantWrite(); // permissions is now 5.
  const wire: ProjectAccessEditorJSON = toWireFormat<ProjectAccessEditor>(access); // permissions is "0x5".
  return { access, before, after: access.canWrite(),
    modelBefore, modelAfter: access.permissions, wire };
}
// #endregion home-example
