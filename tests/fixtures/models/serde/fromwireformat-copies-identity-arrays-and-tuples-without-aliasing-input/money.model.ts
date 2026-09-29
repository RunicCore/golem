import type { IModel } from '@exprtlabs/codegen/model';
import { MemberBase } from './money.model.generated.js';
export type TMember = IModel<{ id: number; emails: string[]; ip: [number, number, number, number] }>;
export class Member extends MemberBase {}
