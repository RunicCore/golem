import type { IModel } from '@exprtlabs/golem/model';
import type { TDepartment } from './department.model.js';
import { TRosterBaseModel } from './roster.model.generated.js';

export type TRoster = IModel<{ departments: TDepartment[] }>;
export class Roster extends TRosterBaseModel {}
