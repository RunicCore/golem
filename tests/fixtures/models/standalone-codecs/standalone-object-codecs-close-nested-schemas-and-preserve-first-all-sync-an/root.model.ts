import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { LeafBase, MiddleBase, RootBase } from './root.model.generated.js';
export type TLeaf = IModel<{ code: string & MinLength<3> }>;
export type TMiddle = IModel<{ child: TLeaf; label: string }>;
export type TRoot = IModel<{ label: string & MinLength<3>; first: TMiddle; second: TMiddle }>;
export class Leaf extends LeafBase {}
export class Middle extends MiddleBase {}
export class Root extends RootBase {}