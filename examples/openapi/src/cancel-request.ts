import type { TasksClient } from '../sdk/index.js';

// #region cancel-request
export async function listWithCancelButton(client: TasksClient, button: { onclick: (() => void) | null }) {
  const controller = new AbortController();
  const request = client.listTasks().execute({}, { signal: controller.signal });
  button.onclick = () => controller.abort(); // Rejects the pending request; does not cancel other operations.
  try {
    return await request;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return undefined;
  }
}
// #endregion cancel-request
