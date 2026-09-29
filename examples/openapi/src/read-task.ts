import type { TasksClient } from '../sdk/index.js';

// #region read-task
export async function readTask(client: TasksClient, id: string) {
  const response = await client.getTask().execute({ path: { id } });
  if (response.status === 404) {
    return response.body.message; // Declared 404: data from the API, not a thrown failure.
  }
  return response.body.title; // Status 200 narrows body to the task type.
}
// #endregion read-task
