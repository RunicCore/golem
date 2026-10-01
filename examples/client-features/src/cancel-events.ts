// #region cancel-events
import { PaymentsClient } from '../sdk/index.js';

const client = new PaymentsClient({ baseUrl: 'https://api.example.com' });
const controller = new AbortController();
const response = await client.readEvents().execute({}, { signal: controller.signal });
controller.abort(); // For example, when the user closes the activity feed.

try {
  for await (const event of response.body) console.log(event.id);
} catch (error) {
  if (!controller.signal.aborted) throw error;
}
// #endregion cancel-events
