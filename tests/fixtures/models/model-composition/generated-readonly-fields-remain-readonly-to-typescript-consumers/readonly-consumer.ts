
import { Item } from './item.model.js';
const item = new Item({ name: 'one', nested: { value: 'two' } });
// @ts-expect-error generated readonly root field must reject assignment
item.name = 'changed';
// @ts-expect-error generated readonly nested field must reject assignment
item.nested.value = 'changed';
void item;
