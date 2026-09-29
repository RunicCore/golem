import { isTasksUndeclaredResponseError, type TasksClient } from '../sdk/index.js';

// #region handle-errors
export async function fetchTask(client: TasksClient, id: string) {
  try {
    return await client.getTask().execute({ path: { id } });
  } catch (error) {
    if (isTasksUndeclaredResponseError(error)) {
      // error.kind === LibErrorKind.Response
      console.error(`Undeclared response for ${id}: HTTP ${error.status}`);
      return undefined;
    }
    throw error; // Network failures reject with the underlying fetch error.
  }
}
// #endregion handle-errors
