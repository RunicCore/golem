
import type { IModel } from '@exprtlabs/golem/model';
type Branch = { kind: 'a'; a: string } | { kind: 'b'; b: number };
export type TItem = IModel<Branch>;
