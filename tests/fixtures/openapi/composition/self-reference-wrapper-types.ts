import type { TreeNode } from './index.js';

declare const node: TreeNode;
const parent: TreeNode | undefined = node.parent;
const children: TreeNode[] | undefined = node.children;

void parent; void children;
