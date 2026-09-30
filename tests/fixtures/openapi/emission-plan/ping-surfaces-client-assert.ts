
import type { PingSurfacesClientOptions } from './client.js';
// Positive pairing for ping-client-assert.ts: an operation with a request
// body, response body, item-schema stream, and content-typed parameter has
// all four codec option fields, and each one accepts an override. Codec
// options do not add auth or mutualTls options.
const options: PingSurfacesClientOptions = {
  baseUrl: 'https://example.test',
  bodyEncoders: {},
  responseDecoders: {},
  streamDecoders: {},
  parameterSerializers: {},
};
// @ts-expect-error a document without security schemes has no auth option
void ({ ...options, auth: {} } satisfies PingSurfacesClientOptions);
// @ts-expect-error a document without a mutualTLS scheme has no mutualTls option
void ({ ...options, mutualTls: { fetchImpl: fetch } } satisfies PingSurfacesClientOptions);
void options;
