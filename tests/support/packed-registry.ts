import { after, before } from 'node:test';
import { startRegistry, type PackedRegistry } from '../../scripts/packed-registry.js';

/** Start the packed-package registry before the tests of a file and close it after them; returns the registry once started. */
export function usePackedRegistry(): () => PackedRegistry {
  let started: PackedRegistry | undefined;
  before(async () => { started = await startRegistry(); });
  after(async () => { await started?.close(); });
  return () => {
    if (!started) throw new Error('The packed registry starts in a before hook');
    return started;
  };
}
