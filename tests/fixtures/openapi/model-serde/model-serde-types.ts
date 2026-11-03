import type { Child, Event } from './types.js';

const event: Event = {
  when: new Date('2025-01-02T03:04:05Z'),
  maybeWhen: null,
  child: { id: 'child' },
  children: [{ id: 'child-2' }],
};
const child: Child = { id: 'child' };
void event; void child;

// @ts-expect-error Date is the converted value of a date-time field; its wire string does not fit the SDK type.
const wrongWhen: Event = { when: '2025-01-02T03:04:05Z', child: { id: 'child' } };
void wrongWhen;
