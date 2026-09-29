
import type { IModel } from '@exprtlabs/codegen/model';
type Branch = { kind: 'a'; a: string } | { kind: 'b'; b: number };
export type TItem = IModel<Branch>;
