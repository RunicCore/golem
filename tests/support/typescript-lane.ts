import { resolveTypeScript } from '#golem/typescript-version';
import { workspace } from './process.js';

/** Whether the TypeScript this run loads is 6.x: the user's `GOLEM_TYPESCRIPT_ROOT` (the TypeScript 6 lane sets one), else the workspace's. */
const onTypeScript6 = resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? workspace).major === 6;

/** The `skip` option of a case that needs TypeScript 7.1 or later: `reason` on TypeScript 6, `false` elsewhere. */
export function skipOnTypeScript6(reason: string): string | false {
  return onTypeScript6 && reason;
}

/** The `skip` option of a case that needs TypeScript 6: `reason` on any other TypeScript, `false` on 6. */
export function skipUnlessTypeScript6(reason: string): string | false {
  return !onTypeScript6 && reason;
}

/** Whether the runner started this process as the TypeScript 6 lane: it points `GOLEM_TYPESCRIPT_ROOT` at the container's TypeScript 6 install (`GOLEM_TYPESCRIPT6_ROOT`). */
export const inTypeScript6Lane = process.env.GOLEM_TYPESCRIPT_ROOT !== undefined && process.env.GOLEM_TYPESCRIPT_ROOT === process.env.GOLEM_TYPESCRIPT6_ROOT;
