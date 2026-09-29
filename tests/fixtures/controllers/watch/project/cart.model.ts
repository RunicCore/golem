import type { IModel } from '@exprtlabs/codegen/model';
import { routePrefix } from './route-helper.js';
export type TCart = IModel<{ id: string; route: typeof routePrefix }>;
