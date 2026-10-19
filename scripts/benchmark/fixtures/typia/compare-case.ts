/** `fail-early` and `fail-late` validate a value with one wrong field, met first and last. `toggle` is a scratch validator. */
export type CompareTask = 'validate' | 'fail-early' | 'fail-late' | 'decode' | 'encode' | 'toggle';
/** The plain `IObject` value, its `IModel` twin (a class instance) and its MobX twin (an observable class instance). */
export type TwinKind = 'plain' | 'imodel' | 'mobx';
/** One timed call of the typia comparison; the runner and the fixture module share this shape. */
export interface CompareCase { readonly model: string; readonly twin: TwinKind; readonly task: CompareTask; readonly side: string; readonly run: () => unknown }
/** How a twin set builds one model value from plain initial data, and the id of the codec that validates it. */
export interface TwinFactory { readonly codecId: string; readonly make: (init: unknown) => object }
export type TwinFactories = Readonly<Record<string, TwinFactory>>;

/** The twin sets that live in other projects: the MobX twins need their own generation profile. */
export interface MobxTwins { readonly mobx: TwinFactories }

/** One model in one form: its codec, the typia validators of the same type, and values to validate. */
export interface Subject {
  readonly model: string;
  readonly twin: TwinKind;
  readonly codecId: string;
  readonly valid: object;
  readonly early: object;
  readonly late: object;
  /** The valid value plus one unknown property. */
  readonly extra: object;
  readonly is: (value: unknown) => boolean;
  readonly equals: (value: unknown) => boolean;
}

export interface Agreement {
  readonly model: string;
  readonly twin: TwinKind;
  readonly probe: 'valid' | 'early' | 'late' | 'extra';
  readonly golem: boolean;
  readonly typiaIs: boolean;
  readonly typiaEquals: boolean;
  readonly agrees: boolean;
}
