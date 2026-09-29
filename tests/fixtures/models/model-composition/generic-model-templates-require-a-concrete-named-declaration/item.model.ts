
import type { IModel } from '@exprtlabs/codegen/model';
export type TBox<T> = IModel<{ value: T }>;
export type TStringBox = IModel<{ box: TBox<string> }>;
