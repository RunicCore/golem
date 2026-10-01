import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { TLeafBaseModel, TMiddleBaseModel, TRootBaseModel } from './root.model.generated.js';
export type TLeaf = IModel<{ code: string & MinLength<3> }>;
export type TMiddle = IModel<{ child: TLeaf; label: string }>;
export type TRoot = IModel<{ label: string & MinLength<3>; first: TMiddle; second: TMiddle }>;
export class Leaf extends TLeafBaseModel {}
export class Middle extends TMiddleBaseModel {}
export class Root extends TRootBaseModel {}