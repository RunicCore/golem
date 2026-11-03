
import type { IModel } from '@exprtlabs/golem/model';
import { TTreeBaseModel, TBranchBaseModel } from './tree.model.generated.js';
export type TBranch = IModel<{ id: string; label: string; children?: Projected[] }>;
type Projected = Omit<TBranch, 'id'>;
export type TTree = IModel<{ branch: Projected }>;
export class Tree extends TTreeBaseModel {}
export class Branch extends TBranchBaseModel {}
