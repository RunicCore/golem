import { listTasks } from './list-tasks.js';

const baseUrl = process.env.TASKS_API_BASE_URL;
if (!baseUrl) {
  console.info('openapi: set TASKS_API_BASE_URL to your Tasks API to run the HTTP example.');
} else {
  const response = await listTasks(baseUrl);
  console.info('openapi: received tasks', response.body);
}
