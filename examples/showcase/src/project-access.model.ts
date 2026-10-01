// #region model-definition
import type { IModel } from '@exprtlabs/golem/model';
import type { ProjectAccess } from '../sdk/index.js';
import { TProjectAccessEditorBaseModel } from './project-access.model.generated.js';
import { WRITE_PERMISSION, type PermissionBits, type ProjectName } from './access-rules.js';

export type TProjectAccessEditor = IModel<
  Omit<ProjectAccess, 'permissions' | 'projectName'> & {
    projectName: ProjectName;
    permissions: PermissionBits;
  }
>;

export class ProjectAccessEditor extends TProjectAccessEditorBaseModel {
  public canWrite(): boolean {
    return (this.permissions & WRITE_PERMISSION) !== 0;
  }

  public grantWrite(): void {
    this.permissions |= WRITE_PERMISSION;
  }
}
// #endregion model-definition
