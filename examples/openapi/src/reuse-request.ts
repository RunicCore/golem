import type { TasksClient } from '../sdk/index.js';

// #region reuse-request
export async function readTwoTasks(client: TasksClient, firstId: string, secondId: string) {
  const getTask = client.getTask();
  const first = await getTask.execute({ path: { id: firstId } });
  const second = await getTask.execute({ path: { id: secondId } });
  return { first, second };
}
// #endregion reuse-request
