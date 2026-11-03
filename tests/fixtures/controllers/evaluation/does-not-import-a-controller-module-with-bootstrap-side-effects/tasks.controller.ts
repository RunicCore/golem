throw new Error('controller-bootstrap');
function Get(path: string) { return (_target: unknown, _key: string) => path; }
class TasksController {
  static base(): string { return "/tasks"; }
  list(): never { throw new Error("controller-bootstrap"); }
}
export const ROUTE = TasksController.base();
