// #region lib-error
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { parse } from '@exprtlabs/golem/serde';
import { Task } from './task.model.js';

export function explainTaskText(text: string): string[] {
  try {
    parse<Task>(text, { failFast: false });
    return [];
  } catch (error) {
    if (!(error instanceof LibError) || !error.causedByInput) throw error; // a program fault
    if (error.kind === LibErrorKind.InvalidJson) return ['The text is not JSON.'];
    return error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
  }
}
// #endregion lib-error
