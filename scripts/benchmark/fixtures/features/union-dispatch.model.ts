import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import { TClassCircleBaseModel, TClassEventsBaseModel, TClassLineBaseModel, TClassRectBaseModel, TClassTextBaseModel, TTaggedEventsBaseModel } from './union-dispatch.model.generated.js';

/**
 * Two models with one wire value: a list of events, each one of four shapes picked by the `kind` tag. In TaggedEvents
 * the shapes are inline objects, so the encoder dispatches on the tag of a plain object. In ClassEvents they are
 * generated model classes, so the encoder picks the branch by the instance's class and then checks the tag. Each shape holds
 * a date, so both models convert a value in every event.
 */
export type TTaggedEvents = IModel<{
  events: ((
    | { kind: 'circle'; radius: number; label: string; at: Date }
    | { kind: 'rect'; width: number; height: number; label: string; at: Date }
    | { kind: 'line'; length: number; label: string; at: Date }
    | { kind: 'text'; text: string; size: number; at: Date }
  ) & Discriminator<'kind'>)[];
}>;
export class TaggedEvents extends TTaggedEventsBaseModel {}

export type TClassCircle = IModel<{ kind: 'circle'; radius: number; label: string; at: Date }>;
export class ClassCircle extends TClassCircleBaseModel {}
export type TClassRect = IModel<{ kind: 'rect'; width: number; height: number; label: string; at: Date }>;
export class ClassRect extends TClassRectBaseModel {}
export type TClassLine = IModel<{ kind: 'line'; length: number; label: string; at: Date }>;
export class ClassLine extends TClassLineBaseModel {}
export type TClassText = IModel<{ kind: 'text'; text: string; size: number; at: Date }>;
export class ClassText extends TClassTextBaseModel {}

export type TClassEvents = IModel<{ events: ((ClassCircle | ClassRect | ClassLine | ClassText) & Discriminator<'kind'>)[] }>;
export class ClassEvents extends TClassEventsBaseModel {}
