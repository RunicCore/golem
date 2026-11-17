import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Controller, Get, Module, Query, type INestApplication, type NestInterceptor, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestModelInterceptor } from '@exprtlabs/golem-ts-openapi/nest';
import { nestModelCodec } from '@exprtlabs/golem-ts-openapi/internal/nest-runtime';

export interface NestAppOptions {
  /** The one global interceptor. Default: NestModelInterceptor. */
  readonly interceptor?: NestInterceptor;
  /** Express 5 reads `filter[status]` as one flat key unless the app opts in to nested query keys. */
  readonly nestedQuery?: true;
  /** Collects each error the app logs as `Name: message`. Without it the app logs nothing. */
  readonly errors?: string[];
}

/** Whether `candidate` is a class: `Reflect.construct` refuses a `newTarget` that is no constructor, before it runs any code of it. */
function isController(candidate: Function): candidate is Type {
  try {
    Reflect.construct(Object, [], candidate);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function requireController(candidate: Function): Type {
  if (!isController(candidate)) throw new TypeError(`A controller must be a class: ${candidate.name || 'anonymous function'}`);
  return candidate;
}

/** Starts a Nest app on a free local port with `controllers` and one global interceptor. The caller closes it. */
export async function startNestApp(controllers: readonly Function[], options: NestAppOptions = {}): Promise<INestApplication> {
  class AppModule {}
  Module({ controllers: controllers.map(requireController) })(AppModule);
  const { errors } = options;
  const logger = errors === undefined ? false : {
    log() {},
    warn() {},
    debug() {},
    verbose() {},
    error(message: unknown, ...rest: unknown[]) {
      errors.push([message, ...rest].map((part) => part instanceof Error ? `${part.name}: ${part.message}` : String(part)).join(' '));
    },
  };
  const application = await NestFactory.create(AppModule, { logger });
  if (options.nestedQuery) application.getHttpAdapter().getInstance().set('query parser', 'extended');
  application.useGlobalInterceptors(options.interceptor ?? new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
  return application;
}

/** Makes `method` of `klass` a GET route that takes a whole @Query() model of codec `id`. */
export function decorateQueryModel(klass: Function, method: string, id: string, route = '/'): void {
  Controller(route)(klass);
  const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, method);
  assert.ok(descriptor);
  Get()(klass.prototype, method, descriptor);
  Query()(klass.prototype, method, 0);
  nestModelCodec(id)(klass.prototype, method, 0);
}
