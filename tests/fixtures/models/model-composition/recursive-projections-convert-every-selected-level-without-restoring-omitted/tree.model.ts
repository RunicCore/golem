
import type { IModel } from '@exprtlabs/golem/model';
import { TreeBaseModel, BranchBaseModel } from './tree.model.generated.js';
export type TBranch = IModel<{ id: string; label: string; children?: Projected[] }>;
type Projected = Omit<TBranch, 'id'>;
export type TTree = IModel<{ branch: Projected }>;
export class Tree extends TreeBaseModel {}
export class Branch extends BranchBaseModel {}
