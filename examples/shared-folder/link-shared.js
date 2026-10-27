import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The worker reaches the shared folder through a folder link, `apps/worker/shared` -> `../../shared`.
// A symlink does not survive every checkout or archive, so the repository keeps no link: this script makes it before each run and .gitignore lists it.
const link = fileURLToPath(new URL('./apps/worker/shared', import.meta.url));
try {
  fs.lstatSync(link);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  fs.symlinkSync('../../shared', link, 'dir');
}
