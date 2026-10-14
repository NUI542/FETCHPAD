import assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { analyze } from '../src/engine/analyze';
import { contentsOf, type Entry } from '../src/extension/contents';

const FIXTURE = path.join(__dirname, 'fixtures', 'mini-app');

let sections: Entry[];
before(() => {
  sections = contentsOf(analyze(FIXTURE));
});

const section = (label: string) => sections.find((s) => s.label === label);

describe('sidebar contents', () => {
  it('lists endpoints, pages, tables and gaps', () => {
    assert.deepEqual(sections.map((s) => s.label), ['Endpoints', 'Pages', 'Tables', 'Gaps']);
    assert.equal(section('Endpoints')!.expanded, true);
  });

  it('groups endpoints by resource and names their handler', () => {
    const groups = section('Endpoints')!.children!;
    const things = groups.find((g) => g.label === '/api/things')!;
    const create = things.children!.find((e) => e.label === 'POST /')!;
    assert.equal(create.description, 'create');
    assert.equal(create.focus, 'route:POST /api/things');
    assert.match(create.tooltip!, /Guards: authenticate → requireRole\('admin'\)/);
    assert.ok(create.source);
  });

  it('flags a request with no server route', () => {
    const groups = section('Endpoints')!.children!;
    const missing = groups.flatMap((g) => g.children!).find((e) => e.description === 'no server route');
    assert.ok(missing);
    assert.equal(missing.icon, 'warning');
  });

  it('opens a gap’s evidence instead of focusing the map', () => {
    const gap = section('Gaps')!.children![0];
    assert.equal(gap.opensSource, true);
    assert.ok(gap.source);
    assert.equal(gap.focus, undefined);
  });

  it('keeps row ids stable between analyses', () => {
    const again = contentsOf(analyze(FIXTURE));
    const ids = (list: Entry[]): string[] => list.flatMap((e) => [e.id, ...ids(e.children ?? [])]);
    assert.deepEqual(ids(again), ids(sections));
  });
});
