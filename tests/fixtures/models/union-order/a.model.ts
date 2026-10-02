import type { IModel } from '@exprtlabs/golem/model';
import type { TOther } from './other.model.js';
export type TA = IModel<{ priority: 'normal' | 'high' | 'low'; mixed: 'x' | 1 | null | boolean; link: 'p' | 'q' | TOther | null }>;
