// #region create-and-list
import { TasksClient } from '../sdk/index.js';

export async function listTasks(baseUrl: string) {
  const client = new TasksClient({ baseUrl });
  const operation = client.listTasks();
  return operation.execute({});
}
// #endregion create-and-list

// #region list-titles
export async function logTaskTitles(client: TasksClient): Promise<string[]> {
  const response = await client.listTasks().execute({});
  for (const task of response.body) {
    console.log(task.title); // "Review"
  }
  return response.body.map(task => task.title);
}
// #endregion list-titles
