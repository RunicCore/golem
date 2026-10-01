// #region backend-model
import type { IModel } from '@exprtlabs/golem/model';
import type { Format, MinLength } from '@exprtlabs/golem/tags';
import type { PermissionBits, ProjectName } from '../src/access-rules.js';
import {
  MemberBaseModel,
  ProjectAccessBaseModel,
} from './project-access.model.generated.js';

export type TMember = IModel<{
  id: string & MinLength<1>;
  name: string & MinLength<2>;
  email: string & Format<'email'>;
}, { exact: true }>;

export class Member extends MemberBaseModel {}

export type TProjectAccess = IModel<{
  projectName: ProjectName;
  member: TMember;
  permissions: PermissionBits;
}, { exact: true }>;

export class ProjectAccess extends ProjectAccessBaseModel {}
// #endregion backend-model
