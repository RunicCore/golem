#!/usr/bin/env node
import { main } from '../tooling/cli.js';
import { errorMessage } from '../tooling/generator-api.js';
main().catch((error: unknown) => { process.stderr.write(`${errorMessage(error)}\n`); process.exitCode = 1; });
