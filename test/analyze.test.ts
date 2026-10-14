import assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { analyze } from '../src/engine/analyze';
import type { MapEdge, MapGraph, MapNode } from '../src/model/types';

const FIXTURE = path.join(__dirname, 'fixtures', 'mini-app');
const api = (name: string) => `js:Frontend/src/services/api.js#${name}:function`;
const model = (name: string) => `js:Backend/src/models/thingModel.js#${name}:function`;
const controller = (name: string) => `js:Backend/src/controllers/thingController.js#${name}:function`;

let graph: MapGraph;
let node: (id: string) => MapNode;
let edges: (kind: MapEdge['kind'], from?: string, to?: string) => MapEdge[];

before(() => {
  graph = analyze(FIXTURE);
  node = (id) => {
    const n = graph.nodes.find((x) => x.id === id);
    assert.ok(n, `missing node ${id}`);
    return n;
  };
  edges = (kind, from, to) => graph.edges.filter((e) => e.kind === kind && (!from || e.from === from) && (!to || e.to === to));
});

describe('express routes', () => {
  it('joins mount prefixes and keeps registration order', () => {
    const routes = graph.nodes.filter((n) => n.kind === 'route' && n.meta?.defined !== false)
      .sort((a, b) => (a.meta!.order as number) - (b.meta!.order as number))
      .map((n) => n.name);
    assert.deepEqual(routes, [
      'GET /',
      'GET /api/things',
      'GET /api/things/mine',
      'GET /api/things/search',
      'GET /api/things/:id',
      'POST /api/things',
      'DELETE /api/things/:id',
    ]);
  });

  it('applies router.use() middleware only to routes registered after it', () => {
    const labels = (id: string) => (node(id).meta!.middleware as { label: string }[]).map((m) => m.label);
    assert.deepEqual(labels('route:GET /api/things'), ['express.json()']);
    assert.deepEqual(labels('route:GET /api/things/mine'), ['express.json()', 'authenticate']);
    assert.deepEqual(labels('route:POST /api/things'), ['express.json()', 'authenticate', "requireRole('admin')"]);
  });

  it('links each route to its handler and middleware functions', () => {
    assert.equal(edges('handles', 'route:POST /api/things', controller('create')).length, 1);
    assert.equal(edges('middleware', 'route:POST /api/things', 'js:Backend/src/middleware/auth.js#requireRole:function').length, 1);
  });
});

describe('client requests', () => {
  it('follows request()/send() wrappers to the route each call reaches', () => {
    const target = (fn: string) => edges('requests', api(fn)).map((e) => `${e.to}${e.resolved ? '' : ' (unresolved)'}`);
    assert.deepEqual(target('thingApi.getAll'), ['route:GET /api/things']);
    assert.deepEqual(target('thingApi.getMine'), ['route:GET /api/things/mine']);
    assert.deepEqual(target('thingApi.getOne'), ['route:GET /api/things/:id']);
    assert.deepEqual(target('thingApi.search'), ['route:GET /api/things/search']);
    assert.deepEqual(target('thingApi.create'), ['route:POST /api/things']);
    assert.deepEqual(target('thingApi.remove'), ['route:DELETE /api/things/:id']);
  });

  it('treats wrappers as wrappers, not as clients of a route', () => {
    assert.equal(edges('requests', api('request')).length, 0);
    assert.equal(edges('requests', api('send')).length, 0);
  });

  it('records the env-var fallback the match depends on', () => {
    const [edge] = edges('requests', api('thingApi.create'));
    assert.match(edge.note ?? '', /VITE_API_URL/);
  });

  it('marks requests with no server route as unresolved, never guessed', () => {
    const [edge] = edges('requests', api('orphanApi.ping'));
    assert.equal(edge.resolved, false);
    assert.equal(node(edge.to).meta!.defined, false);
    assert.ok(graph.gaps.some((g) => g.kind === 'unmatched-request' && g.message.includes('/api/nope')));
  });

  it('fills in a local helper defined inside a test', () => {
    const testUnit = graph.nodes.find((n) => n.layer === 'test' && n.name.startsWith("test('things')"));
    assert.ok(testUnit);
    const reached = edges('requests', testUnit.id).map((e) => e.to).sort();
    assert.deepEqual(reached, ['route:GET /api/things', 'route:POST /api/things']);
  });
});

describe('call chain', () => {
  it('follows controller → service → model, including calls inside callbacks', () => {
    const service = 'js:Backend/src/services/thingService.js#createThing:function';
    assert.equal(edges('calls', controller('create'), service).length, 1);
    assert.equal(edges('calls', service, model('insertThing')).length, 1);
    assert.equal(edges('calls', service, model('renameThing')).length, 1);
    assert.equal(edges('calls', service, 'js:Backend/src/config/db.js#withTransaction:function').length, 1);
  });
});

describe('sql', () => {
  const tables = (kind: 'reads' | 'writes', fn: string) => edges(kind, model(fn)).map((e) => node(e.to).name).sort();

  it('resolves SQL kept in constants and ignores runtime pieces', () => {
    assert.deepEqual(tables('reads', 'listThings'), ['owners', 'things']);
  });

  it('does not mistake CTE names or EXTRACT(... FROM col) for tables', () => {
    assert.deepEqual(tables('reads', 'findThing'), ['things']);
    assert.deepEqual(tables('reads', 'countSince'), ['things']);
  });

  it('finds the written table in INSERT ... ON CONFLICT and dynamic UPDATE', () => {
    assert.deepEqual(tables('writes', 'insertThing'), ['things']);
    assert.deepEqual(tables('reads', 'insertThing'), []);
    assert.deepEqual(tables('writes', 'renameThing'), ['things']);
    assert.deepEqual(tables('writes', 'deleteThing'), ['things']);
  });

  it('reports a table name built at runtime as a gap', () => {
    assert.deepEqual(tables('writes', 'logAudit'), []);
    assert.ok(graph.gaps.some((g) => g.kind === 'dynamic-sql' && g.message.startsWith('logAudit')));
  });
});

describe('schema', () => {
  it('reads tables, columns and both styles of foreign key', () => {
    assert.deepEqual(node('sql:things:table').meta!.columns, ['id', 'name', 'owner_id', 'created_at']);
    assert.equal(node('sql:things.owner_id:column').parent, 'sql:things:table');
    assert.equal(edges('references', 'sql:things:table', 'sql:owners:table').length, 1);
    assert.equal(edges('references', 'sql:tags:table', 'sql:things:table').length, 1);
  });
});

describe('pages', () => {
  it('joins nested React Router paths and links pages to components', () => {
    const page = 'page:/things/new';
    assert.equal(edges('renders', page, 'js:Frontend/src/pages/CreateThing.jsx#CreateThing:component').length, 1);
    assert.equal(node('page:/things:layout').meta!.layout, true);
    assert.equal(edges('renders', 'js:Frontend/src/pages/CreateThing.jsx#CreateThing:component',
      'js:Frontend/src/components/Field.jsx#Field:component').length, 1);
  });
});

describe('layers', () => {
  it('derives each column from the graph, not folder names', () => {
    const layer = (id: string) => node(id).layer;
    assert.equal(layer(controller('create')), 'handler');
    assert.equal(layer('js:Backend/src/services/thingService.js#createThing:function'), 'service');
    assert.equal(layer('js:Backend/src/services/thingService.js#parseThing:function'), 'service');
    assert.equal(layer(model('insertThing')), 'data');
    assert.equal(layer('js:Backend/src/middleware/auth.js#authenticate:function'), 'middleware');
    assert.equal(layer(api('thingApi.create')), 'client');
    assert.equal(layer(api('send')), 'client');
    assert.equal(layer('js:Frontend/src/pages/CreateThing.jsx#CreateThing:component'), 'ui');
    assert.equal(layer('route:POST /api/things'), 'route');
    assert.equal(layer('sql:things:table'), 'table');
  });
});

describe('determinism', () => {
  it('produces the same graph for the same code', () => {
    assert.equal(JSON.stringify(analyze(FIXTURE)), JSON.stringify(graph));
  });
});
