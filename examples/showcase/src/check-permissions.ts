// #region permission-errors
import { validateInstance } from '@exprtlabs/golem/validation';
import { ProjectAccessEditor } from './project-access.model.js';

export async function checkPermissions(): Promise<string | undefined> {
  const draft = new ProjectAccessEditor({
    projectName: 'Release Operations',
    member: { id: 'member-7', name: 'Mina Chen', email: 'mina@example.com' },
    permissions: 4,
  });
  const issues = await validateInstance(draft, { failFast: false });
  return issues.find(issue => issue.path.length === 1 && issue.path[0] === 'permissions')?.message;
}
// #endregion permission-errors
