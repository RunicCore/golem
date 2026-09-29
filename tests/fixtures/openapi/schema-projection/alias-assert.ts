
import type * as InputSchemas from './input-schemas.js';
import type * as OutputSchemas from './output-schemas.js';
const input: InputSchemas.User = { name: 'Ada', secretOne: 'one', secretTwo: 'two' };
const output: OutputSchemas.User = { name: 'Ada', first: 'id-1', second: 'id-2' };
// @ts-expect-error input direction strips readOnly properties
void input.first;
// @ts-expect-error input direction strips readOnly properties
void input.second;
// @ts-expect-error output direction strips writeOnly properties
void output.secretOne;
// @ts-expect-error output direction strips writeOnly properties
void output.secretTwo;
// @ts-expect-error input direction rejects assigning a readOnly property
const inputWithReadOnly: InputSchemas.User = { name: 'Ada', secretOne: 'one', secretTwo: 'two', first: 'id-1', second: 'id-2' };
void input; void output; void inputWithReadOnly;
