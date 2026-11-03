#!/usr/bin/env node
import { main } from '../tooling/cli.js';
import { failureText } from '../tooling/generator-core.js';
main().catch((error: unknown) => { process.stderr.write(`${failureText(error)}\n`); process.exitCode = 1; });
