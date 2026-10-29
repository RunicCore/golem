import { fromWireFormat } from '@exprtlabs/golem/serde';
import { TreeNodeModel } from './index.js';

const node = fromWireFormat<TreeNodeModel>({ name: 'r' });
const parent: TreeNodeModel | undefined = node.parent;
const children: TreeNodeModel[] | undefined = node.children;

void parent; void children;
