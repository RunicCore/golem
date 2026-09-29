import type { CodecsClientOptions } from './client.js';
const options: CodecsClientOptions = { baseUrl: 'https://example.test' };
void ({ ...options, bodyEncoders: {} } satisfies CodecsClientOptions);
void ({ ...options, responseDecoders: {} } satisfies CodecsClientOptions);
void ({ ...options, streamDecoders: {} } satisfies CodecsClientOptions);
// @ts-expect-error a document without security schemes has no auth option
void ({ ...options, auth: {} } satisfies CodecsClientOptions);
// @ts-expect-error a document without a mutualTLS scheme has no mutualTls option
void ({ ...options, mutualTls: { fetchImpl: fetch } } satisfies CodecsClientOptions);
