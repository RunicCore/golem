// #region first-event
import { PaymentsClient } from '../sdk/index.js';

const client = new PaymentsClient({ baseUrl: 'https://api.example.com' });
const response = await client.readEvents().execute({});
for await (const event of response.body) {
  console.log(event.id); // Consume the first event.
  break; // Closes the iterator and cancels its reader.
}
// #endregion first-event
