import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import type { TasksClient } from '../sdk/index.js';

// #region invalid-task
export async function createTaskWithTitle(client: TasksClient, title: string) {
  try {
    return await client.createTask().execute({ body: { id: 'task-1', title } });
  } catch (error) {
    if (error instanceof LibError && error.kind === LibErrorKind.Validation) {
      // Empty title violates minLength; issue.path identifies the title field.
      return error.issues.map(issue => [issue.code, issue.path, issue.message] as const);
    }
    throw error;
  }
}
// #endregion invalid-task
