
import type { Event } from './types.js';
import { ChildModel } from './models.js';
import type { ChildFields, EventFields, EventInit, EventJSON } from './models.js';

const wire: EventJSON = {
  when: '2025-01-02T03:04:05Z',
  maybeWhen: null,
  child: { id: 'child' },
};
const fields: EventFields = {
  when: new Date('2025-01-02T03:04:05Z'),
  maybeWhen: null,
  child: new ChildModel({ id: 'child' }),
};
const init: EventInit = {
  when: new Date('2025-01-02T03:04:05Z'),
  maybeWhen: null,
  child: { id: 'child' },
  children: [{ id: 'child-2' }],
};
const childFields: ChildFields = { id: 'child' };
const event: Event = wire;
void fields; void init; void childFields; void event;

// @ts-expect-error Date is the runtime value, while the wire contract remains a string.
const wrongWire: EventJSON = { when: new Date(), child: { id: 'child' } };
void wrongWire;
