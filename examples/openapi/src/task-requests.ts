import { TasksClient } from '../sdk/index.js';

// #region request-arguments
export async function readTaskPage(client: TasksClient, cursor?: string) {
  return client.listTasks().execute({ query: { limit: 20, cursor } });
}

export async function createTask(client: TasksClient, title: string) {
  return client.createTask().execute({ body: { id: 'task-3', title } });
}
// #endregion request-arguments
