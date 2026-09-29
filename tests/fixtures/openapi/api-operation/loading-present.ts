import { ItemsClient } from './client.js';
const client = new ItemsClient({ baseUrl: 'https://example.test' });
const loading: boolean = client.listItems().loading;
void loading;
