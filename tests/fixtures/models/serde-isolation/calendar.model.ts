import type { IObject } from '@exprtlabs/golem/model';

export type TEvent = IObject<{ at: Date; note?: unknown }, { allowAny: true }>;
export type TCalendar = IObject<{ title: string; event: TEvent; events: TEvent[] }>;
