import assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { analyze } from '../src/engine/analyze';
import { FEATURE_COLUMNS, focusView, GraphIndex, overviewView, type ViewModel } from '../src/webview/views';

const FIXTURE = path.join(__dirname, 'fixtures', 'mini-app');
const fn = (file: string, name: string, kind = 'function') => `js:${file}#${name}:${kind}`;
const CREATE_THING = fn('Frontend/src/pages/CreateThing.jsx', 'CreateThing', 'component');
const CLIENT_CREATE = fn('Frontend/src/services/api.js', 'thingApi.create');
const HANDLER = fn('Backend/src/controllers/thingController.js', 'create');
const SERVICE = fn('Backend/src/services/thingService.js', 'createThing');
const PARSE = fn('Backend/src/services/thingService.js', 'parseThing');
const INSERT = fn('Backend/src/models/thingModel.js', 'insertThing');

let index: GraphIndex;
before(() => {
  index = new GraphIndex(analyze(FIXTURE));
});

const ids = (v: ViewModel) => new Set(v.nodes.map((n) => n.id));
const edge = (v: ViewModel, kind: string, from: string, to: string) => v.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

describe('overview', () => {
  it('links pages to the endpoints their components call', () => {
    const v = overviewView(index, { showReads: false });
    assert.deepEqual(v.columns, ['Pages and callers', 'Endpoints', 'Tables']);
    const e = edge(v, 'requests', 'page:/things/new', 'route:POST /api/things');
    assert.ok(e);
    assert.deepEqual(e.via, [CREATE_THING, CLIENT_CREATE]);
  });

  it('shows the nearest component as caller when no page leads to a request', () => {
    const v = overviewView(index, { showReads: false });
    const provider = fn('Frontend/src/context/SessionContext.jsx', 'SessionProvider', 'component');
    assert.ok(ids(v).has(provider));
    assert.ok(edge(v, 'requests', provider, 'route:GET /api/things/mine'));
    assert.equal(ids(v).has(fn('Frontend/src/App.jsx', 'App', 'component')), false);
  });

  it('draws writes always and reads only on request', () => {
    const plain = overviewView(index, { showReads: false });
    assert.ok(edge(plain, 'writes', 'route:POST /api/things', 'sql:things:table'));
    assert.equal(plain.edges.some((e) => e.kind === 'reads'), false);
    const withReads = overviewView(index, { showReads: true });
    assert.ok(edge(withReads, 'reads', 'route:GET /api/things', 'sql:owners:table'));
  });
});

describe('focus on an endpoint', () => {
  it('shows the chain from page to table', () => {
    const v = focusView(index, 'route:POST /api/things', { showHelpers: false })!;
    for (const id of ['page:/things/new', CREATE_THING, CLIENT_CREATE, 'route:POST /api/things', HANDLER, SERVICE, INSERT, 'sql:things:table']) {
      assert.ok(ids(v).has(id), `missing ${id}`);
    }
    assert.equal(v.nodes.find((n) => n.id === 'route:POST /api/things')!.focus, true);
  });

  it('folds helpers that lead to no table into a count', () => {
    const v = focusView(index, 'route:POST /api/things', { showHelpers: false })!;
    assert.equal(ids(v).has(PARSE), false);
    assert.ok(v.nodes.find((n) => n.id === SERVICE)!.helpers >= 1);
    const all = focusView(index, 'route:POST /api/things', { showHelpers: true })!;
    assert.ok(ids(all).has(PARSE));
  });

  it('leaves tests out and keeps the route component tree out of App', () => {
    const v = focusView(index, 'route:POST /api/things', { showHelpers: false })!;
    assert.equal(v.nodes.some((n) => n.node.layer === 'test'), false);
    assert.equal(ids(v).has(fn('Frontend/src/App.jsx', 'App', 'component')), false);
  });

  it('puts each block in its feature column', () => {
    const v = focusView(index, 'route:POST /api/things', { showHelpers: false })!;
    const column = (id: string) => FEATURE_COLUMNS[v.nodes.find((n) => n.id === id)!.column].layer;
    assert.equal(column('page:/things/new'), 'page');
    assert.equal(column(CREATE_THING), 'ui');
    assert.equal(column(CLIENT_CREATE), 'client');
    assert.equal(column('route:POST /api/things'), 'route');
    assert.equal(column(HANDLER), 'handler');
    assert.equal(column(SERVICE), 'service');
    assert.equal(column(INSERT), 'data');
    assert.equal(column('sql:things:table'), 'table');
  });

  it('carries the route middleware as chips, app code only', () => {
    const v = focusView(index, 'route:POST /api/things', { showHelpers: false })!;
    const route = v.nodes.find((n) => n.id === 'route:POST /api/things')!;
    assert.deepEqual(route.chips.map((c) => c.label), ['authenticate', "requireRole('admin')"]);
    assert.deepEqual(route.libraryMiddleware, ['express.json()']);
  });
});

describe('focus elsewhere stops at endpoints', () => {
  it('from a page: the API it uses, not the backend behind it', () => {
    const v = focusView(index, 'page:/things/new', { showHelpers: false })!;
    assert.ok(ids(v).has('route:POST /api/things'));
    assert.equal(ids(v).has(HANDLER), false);
  });

  it('from a table: the code and endpoints that touch it, not the frontend', () => {
    const v = focusView(index, 'sql:things:table', { showHelpers: false })!;
    assert.ok(ids(v).has(INSERT));
    assert.ok(ids(v).has('route:POST /api/things'));
    assert.equal(ids(v).has(CLIENT_CREATE), false);
  });
});
