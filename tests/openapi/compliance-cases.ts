import type {
  EvidenceId,
  OpenApiVersion,
} from '../../packages/golem-openapi/compliance/capabilities.js';

export type NativeRequestCodec = 'none' | 'json' | 'form';
export type NativeResponseCodec = 'empty' | 'json' | 'binary';

export interface UpstreamResponseCase {
  readonly status: string;
  readonly contentType: string | null;
  readonly codec: NativeResponseCodec;
  readonly body?: unknown;
  readonly bodyBytes?: readonly number[];
}

export interface UpstreamOperationCase {
  readonly id: string;
  readonly fixture: string;
  readonly version: OpenApiVersion;
  readonly operation: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly requestCodec: NativeRequestCodec;
  readonly response: UpstreamResponseCase;
  readonly evidenceIds: readonly EvidenceId[];
}

const OPERATION_EVIDENCE = ['upstream-operation-cases', 'upstream-native-codecs'] as const satisfies readonly EvidenceId[];

function operationCase(
  fixture: string,
  version: OpenApiVersion,
  operation: string,
  input: Readonly<Record<string, unknown>>,
  response: UpstreamResponseCase,
  requestCodec: NativeRequestCodec = 'none',
): UpstreamOperationCase {
  return {
    id: `upstream.${version}.${operation}`,
    fixture,
    version,
    operation,
    input,
    requestCodec,
    response,
    evidenceIds: OPERATION_EVIDENCE,
  };
}

const jsonResponse = (status: string, body: unknown): UpstreamResponseCase => ({
  status,
  contentType: 'application/json',
  codec: 'json',
  body,
});

const emptyResponse = (status: string): UpstreamResponseCase => ({
  status,
  contentType: null,
  codec: 'empty',
});

const binaryResponse = (status: string, bodyBytes: readonly number[]): UpstreamResponseCase => ({
  status,
  contentType: 'image/png',
  codec: 'binary',
  bodyBytes,
});

export const UPSTREAM_OPERATION_CASES: readonly UpstreamOperationCase[] = [
  operationCase(
    'oai/3.1-converted/api-with-examples.yaml',
    '3.1',
    'listVersionsv2',
    {},
    jsonResponse('200', {}),
  ),
  operationCase(
    'oai/3.1-converted/api-with-examples.yaml',
    '3.1',
    'getVersionDetailsv2',
    {},
    jsonResponse('200', {}),
  ),
  operationCase(
    'oai/3.1-converted/callback-example.yaml',
    '3.1',
    'postStreams',
    { query: { callbackUrl: 'https://example.test/callback' } },
    jsonResponse('201', { subscriptionId: 'case-subscription' }),
  ),
  operationCase(
    'oai/3.1-converted/link-example.yaml',
    '3.1',
    'getUserByName',
    { path: { username: 'alice' } },
    jsonResponse('200', { username: 'alice' }),
  ),
  operationCase(
    'oai/3.1-converted/link-example.yaml',
    '3.1',
    'getRepositoriesByOwner',
    { path: { username: 'alice' } },
    jsonResponse('200', []),
  ),
  operationCase(
    'oai/3.1-converted/link-example.yaml',
    '3.1',
    'getRepository',
    { path: { username: 'alice', slug: 'example' } },
    jsonResponse('200', { slug: 'example', owner: { username: 'alice' } }),
  ),
  operationCase(
    'oai/3.1-converted/link-example.yaml',
    '3.1',
    'getPullRequestsByRepository',
    { path: { username: 'alice', slug: 'example' }, query: { state: 'open' } },
    jsonResponse('200', []),
  ),
  operationCase(
    'oai/3.1-converted/link-example.yaml',
    '3.1',
    'getPullRequestsById',
    { path: { username: 'alice', slug: 'example', pid: '1' } },
    jsonResponse('200', {
      id: 1,
      author: { username: 'alice' },
      repository: { slug: 'example' },
    }),
  ),
  operationCase(
    'oai/3.1-converted/link-example.yaml',
    '3.1',
    'mergePullRequest',
    { path: { username: 'alice', slug: 'example', pid: '1' } },
    emptyResponse('204'),
  ),
  operationCase(
    'oai/3.1-converted/petstore-expanded.yaml',
    '3.1',
    'findPets',
    { query: { tags: ['cat'], limit: 1 } },
    jsonResponse('200', []),
  ),
  operationCase(
    'oai/3.1-converted/petstore-expanded.yaml',
    '3.1',
    'addPet',
    { body: { name: 'case-pet', tag: 'case' } },
    jsonResponse('200', { id: 1, name: 'case-pet', tag: 'case' }),
    'json',
  ),
  operationCase(
    'oai/3.1-converted/petstore-expanded.yaml',
    '3.1',
    'findPetById',
    { path: { id: 1 } },
    jsonResponse('200', { id: 1, name: 'case-pet' }),
  ),
  operationCase(
    'oai/3.1-converted/petstore-expanded.yaml',
    '3.1',
    'deletePet',
    { path: { id: 1 } },
    emptyResponse('204'),
  ),
  operationCase(
    'oai/3.1-converted/petstore.yaml',
    '3.1',
    'listPets',
    { query: { limit: 1 } },
    jsonResponse('200', []),
  ),
  operationCase(
    'oai/3.1-converted/petstore.yaml',
    '3.1',
    'createPets',
    { body: { id: 1, name: 'case-pet' } },
    emptyResponse('201'),
    'json',
  ),
  operationCase(
    'oai/3.1-converted/petstore.yaml',
    '3.1',
    'showPetById',
    { path: { petId: '1' } },
    jsonResponse('200', { id: 1, name: 'case-pet' }),
  ),
  operationCase(
    'oai/3.1-converted/uspto.yaml',
    '3.1',
    'listDataSets',
    {},
    jsonResponse('200', {}),
  ),
  operationCase(
    'oai/3.1-converted/uspto.yaml',
    '3.1',
    'listSearchableFields',
    { path: { dataset: 'oa_citations', version: 'v1' } },
    jsonResponse('200', 'case-fields'),
  ),
  operationCase(
    'oai/3.1-converted/uspto.yaml',
    '3.1',
    'performSearch',
    {
      path: { dataset: 'oa_citations', version: 'v1' },
      body: { criteria: '*:*', start: 0, rows: 1 },
    },
    jsonResponse('200', []),
    'form',
  ),
  operationCase(
    'redocly/3.1/museum.yaml',
    '3.1',
    'getMuseumHours',
    { query: { startDate: '2023-02-23', page: 1, limit: 1 } },
    jsonResponse('200', []),
  ),
  operationCase(
    'redocly/3.1/museum.yaml',
    '3.1',
    'listSpecialEvents',
    { query: { startDate: '2023-02-23', endDate: '2023-04-18', page: 1, limit: 1 } },
    jsonResponse('200', []),
  ),
  operationCase(
    'redocly/3.1/museum.yaml',
    '3.1',
    'createSpecialEvent',
    {
      body: {
        name: 'Case event',
        location: 'Computer Room',
        eventDescription: 'A case event',
        dates: ['2023-10-29'],
        price: 25,
      },
    },
    jsonResponse('201', {
      eventId: '3be6453c-03eb-4357-ae5a-984a0e574a54',
      name: 'Case event',
      location: 'Computer Room',
      eventDescription: 'A case event',
      dates: ['2023-10-29'],
      price: 25,
    }),
    'json',
  ),
  operationCase(
    'redocly/3.1/museum.yaml',
    '3.1',
    'getSpecialEvent',
    { path: { eventId: 'dad4bce8-f5cb-4078-a211-995864315e39' } },
    jsonResponse('200', {
      eventId: 'dad4bce8-f5cb-4078-a211-995864315e39',
      name: 'Case event',
      location: 'Computer Room',
      eventDescription: 'A case event',
      dates: ['2023-10-29'],
      price: 25,
    }),
  ),
  operationCase(
    'redocly/3.1/museum.yaml',
    '3.1',
    'deleteSpecialEvent',
    { path: { eventId: 'dad4bce8-f5cb-4078-a211-995864315e39' } },
    emptyResponse('204'),
  ),
  operationCase(
    'redocly/3.1/museum.yaml',
    '3.1',
    'updateSpecialEvent',
    {
      path: { eventId: 'dad4bce8-f5cb-4078-a211-995864315e39' },
      body: { name: 'Updated case event', price: 30 },
    },
    jsonResponse('200', {
      eventId: 'dad4bce8-f5cb-4078-a211-995864315e39',
      name: 'Updated case event',
      location: 'Computer Room',
      eventDescription: 'A case event',
      dates: ['2023-10-29'],
      price: 30,
    }),
    'json',
  ),
  operationCase(
    'redocly/3.1/museum.yaml',
    '3.1',
    'buyMuseumTickets',
    {
      body: {
        ticketType: 'general',
        ticketDate: '2023-10-29',
        email: 'museum-lover@example.com',
      },
    },
    jsonResponse('201', {
      message: 'Museum general entry ticket purchased',
      ticketId: 'a54a57ca-36f8-421b-a6b4-2e8f26858a4c',
      ticketType: 'general',
      ticketDate: '2023-10-29',
      confirmationCode: 'ticket-general-case',
    }),
    'json',
  ),
  operationCase(
    'redocly/3.1/museum.yaml',
    '3.1',
    'getTicketCode',
    { path: { ticketId: 'a54a57ca-36f8-421b-a6b4-2e8f26858a4c' } },
    binaryResponse('200', [1, 2, 3]),
  ),
  operationCase(
    'openapi-to-rust/3.1/components/path-items-component.yaml',
    '3.1',
    'listThings',
    {},
    emptyResponse('200'),
  ),
  operationCase(
    'openapi-to-rust/3.1/parameter/deepobject-query.yaml',
    '3.1',
    'search',
    { query: { filter: { kind: 'museum', region: 'vn' } } },
    emptyResponse('200'),
  ),
  operationCase(
    'openapi-to-rust/3.1/parameter/header-required.yaml',
    '3.1',
    'createThing',
    { header: { 'Idempotency-Key': 'case-1' }, body: { name: 'thing' } },
    emptyResponse('201'),
    'json',
  ),
  operationCase(
    'openapi-to-rust/3.1/security/mutual-tls.yaml',
    '3.1',
    'getPrivate',
    {},
    emptyResponse('200'),
  ),
  operationCase(
    'openapi-to-rust/3.2/components/media-types-component.yaml',
    '3.2',
    'getThing',
    {},
    jsonResponse('200', { name: 'thing' }),
  ),
  operationCase(
    'openapi-to-rust/3.2/pathitem/additional-operations.yaml',
    '3.2',
    'linkThings',
    {},
    emptyResponse('200'),
  ),
  operationCase(
    'openapi-to-rust/3.2/pathitem/additional-operations.yaml',
    '3.2',
    'unlinkThings',
    {},
    emptyResponse('200'),
  ),
  operationCase(
    'openapi-to-rust/3.2/pathitem/query-method.yaml',
    '3.2',
    'search',
    { body: { filter: 'museum' } },
    jsonResponse('200', ['case-result']),
    'json',
  ),
] as const;

export interface InboundContractCase {
  readonly id: string;
  readonly fixture: string;
  readonly version: OpenApiVersion;
  readonly operation: string;
  readonly evidenceIds: readonly EvidenceId[];
}

export const INBOUND_CONTRACT_CASES: readonly InboundContractCase[] = [
  {
    id: 'inbound.3.1.callback-post-streams',
    fixture: 'oai/3.1-converted/callback-example.yaml',
    version: '3.1',
    operation: 'callbackPostStreamsOnDataPost$requestQueryCallbackUrlData',
    evidenceIds: ['upstream-inbound-contracts'],
  },
  {
    id: 'inbound.3.1.webhook-new-pet',
    fixture: 'openapi-to-rust/3.1/webhooks/basic-webhook.yaml',
    version: '3.1',
    operation: 'webhookNewPetPostNewPet',
    evidenceIds: ['upstream-inbound-contracts'],
  },
] as const;

export function caseKey(fixture: string, operation: string): string {
  return `${fixture}\0${operation}`;
}

export function assertCaseTableIntegrity(): void {
  const ids = new Set<string>();
  for (const item of UPSTREAM_OPERATION_CASES) {
    if (ids.has(item.id)) throw new Error(`duplicate upstream compliance case id: ${item.id}`);
    ids.add(item.id);
  }
  for (const item of INBOUND_CONTRACT_CASES) {
    if (ids.has(item.id)) throw new Error(`duplicate inbound compliance case id: ${item.id}`);
    ids.add(item.id);
  }
}
