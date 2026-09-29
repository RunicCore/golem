import { validateInstance } from '@exprtlabs/codegen/validation';
import { editAccess } from './edit-access.js';
import { ProjectAccessEditor } from './project-access.model.js';

export async function runHomeDemo() {
  const example = editAccess();
  const { access } = example;

  const invalid = new ProjectAccessEditor({
    ...access,
    permissions: 4,
  });
  const issues = await validateInstance(invalid, { failFast: false });
  const customFailure = issues.find(issue => issue.path.length === 1 && issue.path[0] === 'permissions')?.message;
  // expected custom failure: "A project access record must include the read permission bit."
  return { ...example, customFailure };
}
