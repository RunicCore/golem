import { getTask } from '../sdk/operations/getTask.js';

// #region standalone-operation
export function readTaskDirectly(baseUrl: string, id: string) {
  const taskRequest = getTask({ baseUrl });
  return taskRequest.execute({ path: { id } });
}
// #endregion standalone-operation
