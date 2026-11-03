import { ItemsClient } from './client.js';
const client = new ItemsClient({ baseUrl: 'https://example.test' });
const operation = client.listItems();
void operation.execute;
// @ts-expect-error generated operations have no loading without MobX
void operation.loading;
