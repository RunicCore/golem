
import type { IModel } from '@exprtlabs/golem/model';
export type TBox<T> = IModel<{ value: T }>;
export type TStringBox = IModel<{ box: TBox<string> }>;
