import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { TreeNodeModel } from './index.js';

const node = decodeGeneratedModel(TreeNodeModel, { name: 'r' });
const parent: TreeNodeModel | undefined = node.parent;
const children: TreeNodeModel[] | undefined = node.children;

void parent; void children;
