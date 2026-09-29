import { ExpressAdapter } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { createApplication } from './application.js';
import { registerApplicationTests } from './app-workflows.js';

const selectedAdapter = process.env.TEST_HTTP_ADAPTER;
if (selectedAdapter !== 'express' && selectedAdapter !== 'fastify') {
  throw new Error(`Expected TEST_HTTP_ADAPTER to select Express or Fastify, got ${JSON.stringify(selectedAdapter)}.`);
}

registerApplicationTests(
  () => createApplication(selectedAdapter === 'fastify' ? new FastifyAdapter() : new ExpressAdapter()),
  selectedAdapter,
);
