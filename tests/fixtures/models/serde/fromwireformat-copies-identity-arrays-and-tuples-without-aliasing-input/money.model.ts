import type { IModel } from '@exprtlabs/golem/model';
import { MemberBaseModel } from './money.model.generated.js';
export type TMember = IModel<{ id: number; emails: string[]; ip: [number, number, number, number] }>;
export class Member extends MemberBaseModel {}
