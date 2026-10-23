import { realpathSync } from 'node:fs';
import { resolveTypeScript } from './typescript-version.js';

/** The TypeScript install a process loads, as `resolveTypeScript` describes it. */
type SelectedTypeScript = ReturnType<typeof resolveTypeScript>;

/** What the choice came from: the user's override, the project a host asked for, or the working directory. */
type SelectionSource = 'GOLEM_TYPESCRIPT_ROOT' | 'request' | 'cwd';

interface Selection {
  readonly typescript: SelectedTypeScript;
  readonly source: SelectionSource;
  readonly root: string;
}

/**
 * The choice lives on `globalThis`, not in the module: npm can nest a second copy of golem (the generators depend on it), and
 * both copies belong to one process that loads one compiler.
 */
interface SelectionState {
  requested: string | undefined;
  selection: Selection | undefined;
}

const stateKey = Symbol.for('@exprtlabs/golem/typescript-selection');
const shared = globalThis as typeof globalThis & { [stateKey]?: SelectionState };
const state: SelectionState = (shared[stateKey] ??= { requested: undefined, selection: undefined });

/** The directory whose TypeScript the process loads, and where that directory came from. GOLEM_TYPESCRIPT_ROOT overrides a request, which overrides the working directory. */
function chosenRoot(): { readonly root: string; readonly source: SelectionSource } {
  const override = process.env.GOLEM_TYPESCRIPT_ROOT;
  if (override !== undefined) return { root: override, source: 'GOLEM_TYPESCRIPT_ROOT' };
  if (state.requested !== undefined) return { root: state.requested, source: 'request' };
  return { root: process.cwd(), source: 'cwd' };
}

function origin(chosen: Selection): string {
  if (chosen.source === 'request') return `the project at ${chosen.root}`;
  return `the working directory ${chosen.root}, before any project asked for its TypeScript: a module that loads the compiler early selected it`;
}

/**
 * The one TypeScript this process loads, chosen on first use and kept. A process loads one compiler, so the compiler seam
 * and its backends all read this answer.
 */
export function selectedTypeScript(): SelectedTypeScript {
  if (state.selection === undefined) {
    const { root, source } = chosenRoot();
    state.selection = { typescript: resolveTypeScript(root), source, root };
  }
  return state.selection.typescript;
}

/**
 * A project asks for the TypeScript beside its tsconfig; the golem command and every host ask here. It takes effect when
 * nothing has selected one yet; afterwards the process must already hold the same install, compared by real path so that two
 * projects sharing a hoisted or linked install agree. A different install throws: run one host per TypeScript install.
 * GOLEM_TYPESCRIPT_ROOT overrides every request and is never compared.
 *
 * A request resolves the project's TypeScript now, so a root without a usable one throws before the module that loads the
 * compiler is imported; the module system keeps a failed import for the life of the process. The golem command passes
 * `lazy`: it needs a compiler only when a job asks for one, so its request is kept unresolved until a module selects.
 */
export function requestTypeScriptRoot(root: string, options: { readonly lazy?: boolean } = {}): void {
  if (process.env.GOLEM_TYPESCRIPT_ROOT !== undefined) return;
  if (options.lazy === true && state.selection === undefined && state.requested === undefined) {
    state.requested = root;
    return;
  }
  const wanted = resolveTypeScript(root);
  const held = state.selection ?? (state.requested === undefined ? undefined : { typescript: resolveTypeScript(state.requested), source: 'request' as const, root: state.requested });
  if (held === undefined) {
    state.requested = root;
    return;
  }
  if (held.source === 'GOLEM_TYPESCRIPT_ROOT' || realpathSync(held.typescript.packageDir) === realpathSync(wanted.packageDir)) return;
  throw new Error(`One golem process loads one TypeScript: ${held.typescript.version} at ${held.typescript.packageDir} was selected from ${origin(held)}, but the project at ${root} uses ${wanted.version} at ${wanted.packageDir}. Run one golem host per TypeScript install.`);
}
