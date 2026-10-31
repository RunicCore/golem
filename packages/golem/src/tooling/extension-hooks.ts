// Hook routing (page "What an extension declares", hook participant). A job offers hooks by name in its facts; an enabled extension's entry
// exports `hooks: { [hookName]: participant }`. Core hands each job the participants that fill the hooks it offers. Core names no hook, package
// or extension: the contract of a hook, the type of its participant, belongs to the package of the job that offers it.
import { errorMessage } from './generator-core.js';
import type { GolemJob } from './generator-core.js';
import { ExtensionFaultError, loadExtensions } from './rewrite-participant.js';
import type { EnabledExtension } from './rewrite-participant.js';

/** One extension's participant for a hook, as the job that offers the hook receives it in `context.hooks[hookName]`. */
export interface HookFill<Participant = unknown> {
  /** The package that registers the extension. */
  readonly package: string;
  /** The name under `extensions:` in golem.yaml. */
  readonly extension: string;
  /** The value under the name in golem.yaml; an empty entry is `{}`. */
  readonly options: Readonly<Record<string, unknown>>;
  readonly participant: Participant;
  /**
   * Calls the participant through `call`. A participant that throws, or whose promise rejects, is a fault in the extension's package: the run
   * stops with the package named (`ExtensionFaultError`). A job calls its participants through this method, never directly.
   */
  use<Result>(call: (participant: Participant) => Result): Result;
}

/** The participants that fill the hooks of one job: each hook it offers, with an empty list when no extension fills it. */
export type HookParticipants = Readonly<Record<string, readonly HookFill[]>>;

/** What core routed to one job: the participants for its context, and the extensions behind them, in the order of golem.yaml. */
export interface JobHooks {
  readonly participants: HookParticipants;
  /** Each pair of a hook and the extension that fills it, for the job cache. */
  readonly filled: readonly { readonly hook: string; readonly extension: EnabledExtension }[];
}

function fill(hook: string, extension: EnabledExtension, participant: unknown): HookFill {
  const fault = (error: unknown): ExtensionFaultError => error instanceof ExtensionFaultError
    ? error
    : new ExtensionFaultError(extension, `threw while it filled the hook "${hook}": ${errorMessage(error)}`, { cause: error });
  return {
    package: extension.package,
    extension: extension.name,
    options: extension.options,
    participant,
    use<Result>(call: (participant: unknown) => Result): Result {
      let result: Result;
      try { result = call(participant); }
      catch (error) { throw fault(error); }
      return result instanceof Promise ? result.catch((error: unknown) => { throw fault(error); }) as Result : result;
    },
  };
}

/**
 * Loads the enabled extensions and routes their participants to the jobs that offer the hooks they fill. An extension that fills a hook that
 * no job of the golem.yaml offers is a configuration error: it names the extension and the hook, and lists the hooks offered. Returns an
 * entry for each job that offers a hook, with an empty list for a hook that no extension fills; no extension is loaded when the config enables none.
 */
export async function routeHooks(jobs: readonly GolemJob[], extensions: readonly EnabledExtension[]): Promise<ReadonlyMap<string, JobHooks>> {
  const routes = new Map<string, JobHooks>();
  const loaded = extensions.length ? await loadExtensions(extensions) : [];
  const offered = [...new Set(jobs.flatMap(job => job.facts.hooks))].sort();
  for (const { extension, hooks } of loaded) {
    for (const hook of Object.keys(hooks)) {
      if (!offered.includes(hook)) {
        throw new Error(`Extension "${extension.name}" of ${extension.package} (block ${extension.block}) fills the hook "${hook}", which no job of this golem.yaml offers. ${offered.length ? `Hooks offered: ${offered.join(', ')}.` : 'No job offers a hook.'}`);
      }
    }
  }
  for (const job of jobs) {
    if (!job.facts.hooks.length) continue;
    const filled = loaded.flatMap(({ extension, hooks }) => job.facts.hooks.filter(hook => Object.hasOwn(hooks, hook)).map(hook => ({ hook, extension, fill: fill(hook, extension, hooks[hook]) })));
    const participants = Object.fromEntries(job.facts.hooks.map(hook => [hook, filled.filter(item => item.hook === hook).map(item => item.fill)]));
    routes.set(job.id, { participants, filled: filled.map(({ hook, extension }) => ({ hook, extension })) });
  }
  return routes;
}
