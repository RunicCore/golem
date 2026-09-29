
import type { IModel } from '@exprtlabs/codegen/model';
import { TreeBase, BranchBase } from './tree.model.generated.js';
export type TBranch = IModel<{ id: string; label: string; children?: Projected[] }>;
type Projected = Omit<TBranch, 'id'>;
export type TTree = IModel<{ branch: Projected }>;
export class Tree extends TreeBase {}
export class Branch extends BranchBase {}
