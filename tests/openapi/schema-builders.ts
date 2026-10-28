/** Fragments for the OpenAPI documents of tests, shared where a document only needs a plain date, reference, object or operation. */

export const dateTime = { type: 'string', format: 'date-time' };

export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', required, properties });

/** A POST operation that takes and returns the component schema `schema` as JSON. */
export const operation = (id: string, schema: string) => ({
  post: {
    operationId: id,
    requestBody: { required: true, content: { 'application/json': { schema: ref(schema) } } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref(schema) } } } },
  },
});
