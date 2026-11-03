import { register } from 'node:module';

// Use with `node --import @exprtlabs/golem/register`, which hooks every later import of the process.
register('./loader.js', import.meta.url);
