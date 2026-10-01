// #region read-events
import { PaymentsClient } from '../sdk/index.js';

const client = new PaymentsClient({ baseUrl: 'https://api.example.com' });
// API response: {"id":1} followed by a newline, then {"id":2}.
const response = await client.readEvents().execute({});

for await (const event of response.body) {
  console.log(event.id); // Prints 1, then 2 as those items arrive.
}
// #endregion read-events
