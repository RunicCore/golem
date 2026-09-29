import { TasksClient, type TasksClientOptions } from '../sdk/index.js';

// #region create-client
export function createTasksClient(options: TasksClientOptions): TasksClient {
  return new TasksClient(options);
}
// #endregion create-client
