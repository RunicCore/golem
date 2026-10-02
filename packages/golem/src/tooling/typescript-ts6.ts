// Placeholder until the TypeScript 6 backend lands; the facade imports this module only for TypeScript 6 projects.
import { UnsupportedTypeScriptError } from './typescript-version.js';

throw new UnsupportedTypeScriptError('golem\'s TypeScript 6 backend is not built yet.');
