import type { IModel } from '@exprtlabs/golem/model';
import type { TOther } from './other.model.js';
export type TB = IModel<{ priority: 'low' | 'high' | 'normal'; mixed: boolean | null | 1 | 'x'; link: null | TOther | 'q' | 'p' }>;
