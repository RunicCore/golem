import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { TMemberModel, ProjectAccessClient } from '../sdk/index.js';
import { checkPermissions } from './check-permissions.js';
import { editAccess } from './edit-access.js';
import { runHomeDemo } from './home-demo.js';
import { saveProjectAccessOverHttp } from './http.js';
import { ProjectAccessEditor } from './project-access.model.js';
import { saveProjectAccess } from './save-access.js';

const validWire = {
  projectName: 'Release Operations',
  member: { id: 'member-7', name: 'Mina Chen', email: 'mina@example.com' },
  permissions: '0x5',
};

test('editAccess converts, edits and returns API data', () => {
  const { wire } = editAccess();
  assert.deepEqual(wire, {
    projectName: 'Release Operations',
    member: { id: 'member-7', name: 'Mina Chen', email: 'mina@example.com' },
    permissions: '0x5',
  });
});

test('home demo keeps the wire-to-model-to-wire path and custom failure visible', async () => {
  const example = await runHomeDemo();

  assert.equal(example.modelBefore, 1);
  assert.equal(example.before, false);
  assert.equal(example.modelAfter, 5);
  assert.equal(example.after, true);
  assert.equal(example.wire.permissions, '0x5');
  assert.equal(example.customFailure, 'A project access record must include the read permission bit.');
  assert.ok(example.access.member instanceof TMemberModel);
});

test('project access deserializes nested SDK members and serializes numeric permissions as hex', async () => {
  const access = fromWireFormat<ProjectAccessEditor>({ ...validWire, permissions: '0x1' });

  assert.ok(access.member instanceof TMemberModel);
  assert.equal(access.permissions, 1);
  assert.equal(access.canWrite(), false);
  access.grantWrite();
  assert.equal(access.canWrite(), true);
  assert.deepEqual(toWireFormat<ProjectAccessEditor>(access), validWire);

  const copy = fromWireFormat<ProjectAccessEditor>(toWireFormat<ProjectAccessEditor>(access));
  assert.ok(copy instanceof ProjectAccessEditor);
  assert.equal(copy.member.name, 'Mina Chen');
});

test('project access reports generated and custom field errors before editing', async () => {
  const access = new ProjectAccessEditor({
    projectName: 'A',
    member: { id: '', name: 'M', email: 'invalid' },
    permissions: 4,
  });
  const errors = await validateInstance(access, { failFast: false });

  assert.ok(errors.some(issue => issue.path.length === 1 && issue.path[0] === 'projectName'));
  assert.ok(errors.some(issue => issue.path.length === 1 && issue.path[0] === 'permissions' && /read permission/i.test(issue.message)));

  const memberErrors = await validateInstance(access.member, { failFast: false });
  assert.ok(memberErrors.some(issue => issue.path.join('.') === 'id'));
  assert.ok(memberErrors.some(issue => issue.path.join('.') === 'email'));

  access.projectName = 'Release Operations';
  access.member.id = 'member-7';
  access.member.name = 'Mina Chen';
  access.member.email = 'mina@example.com';
  access.permissions = 5;
  assert.deepEqual(await validateInstance(access), []);
  assert.deepEqual(await validateInstance(access.member), []);
});

test('project access reports nested generated member issues at their parent path', async () => {
  const access = new ProjectAccessEditor({
    projectName: 'Release Operations',
    member: { id: 'member-7', name: 'Mina Chen', email: 'invalid' },
    permissions: 5,
  });

  const issues = await validateInstance(access, { failFast: false });
  assert.ok(issues.some(issue =>
    issue.path.length === 2
      && issue.path[0] === 'member'
      && issue.path[1] === 'email'
      && issue.source === 'openapi',
  ));
});

test('permission checks expose the custom message for a missing read bit', async () => {
  assert.equal(await checkPermissions(), 'A project access record must include the read permission bit.');
});

test('project access sends the serialized body through the generated client when an endpoint is supplied', async () => {
  const access = fromWireFormat<ProjectAccessEditor>(validWire);
  const requests: Request[] = [];
  const client = new ProjectAccessClient({
    baseUrl: 'https://example.test',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(await request.clone().json(), { status: 200 });
    },
  });

  const response = await saveProjectAccess(client, 'project-ops', access);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, validWire);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'PUT');
  assert.equal(requests[0]?.url, 'https://example.test/projects/project-ops/access');
  assert.deepEqual(await requests[0]?.clone().json(), validWire);
});

test('the optional HTTP adapter uses the injected fixture transport', async () => {
  const access = fromWireFormat<ProjectAccessEditor>(validWire);
  let calls = 0;
  const response = await saveProjectAccessOverHttp(
    'https://fixture.test',
    'project-ops',
    access,
    async (input, init) => {
      calls += 1;
      const request = new Request(input, init);
      assert.equal(request.method, 'PUT');
      assert.deepEqual(await request.clone().json(), validWire);
      return Response.json(validWire, { status: 200 });
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(response.body, validWire);
});
