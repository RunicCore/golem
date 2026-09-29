import { TasksClient } from '../sdk/index.js';

// #region shared-headers
export function createClientWithLocale(baseUrl: string, language: string): TasksClient {
  return new TasksClient({
    baseUrl,
    headers: { 'Accept-Language': language }, // Sent with every request from this client.
  });
}
// #endregion shared-headers
