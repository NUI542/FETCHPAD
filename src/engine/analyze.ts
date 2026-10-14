import type * as ts from 'typescript';
import type { MapGraph } from '../model/types';
import { analyzeCalls } from './adapters/calls';
import { analyzeExpress } from './adapters/express';
import { analyzeHttpClient } from './adapters/httpClient';
import { analyzeReactRouter } from './adapters/reactRouter';
import { analyzeSchema, analyzeSqlUsage } from './adapters/sql';
import { GraphBuilder } from './graph';
import { assignLayers } from './layers';
import { loadProject, SourceFileCache, type Project } from './project';
import { UnitIndex } from './units';

/** Build the map of a project. Same source in, same graph out. */
export function analyze(root: string): MapGraph {
  return new Analyzer(root).run();
}

/**
 * Re-runnable analysis of one project. Keeps parsed files between runs, so
 * after an edit only the changed files are parsed again.
 */
export class Analyzer {
  private cache = new SourceFileCache();
  private program?: ts.Program;

  constructor(readonly root: string) {}

  run(): MapGraph {
    const project = loadProject(this.root, { cache: this.cache, oldProgram: this.program });
    this.program = project.program;
    return build(project);
  }
}

function build(project: Project): MapGraph {
  const graph = new GraphBuilder(project.root);
  const units = new UnitIndex(project, graph);

  analyzeCalls(project, units, graph);
  analyzeReactRouter(project, units, graph);
  const routes = analyzeExpress(project, units, graph);
  analyzeHttpClient(project, units, graph, routes);
  const schemaTables = analyzeSchema(project, graph);
  analyzeSqlUsage(project, units, graph, schemaTables);

  // A foreign key can name a table no schema file defines.
  for (const edge of graph.allEdges()) {
    if (!graph.getNode(edge.to) && edge.to.startsWith('sql:')) {
      const name = edge.to.slice('sql:'.length, -':table'.length);
      graph.addNode({ id: edge.to, kind: 'table', name, ranges: [], lang: 'sql', meta: { inSchema: false } });
    }
  }

  const result = graph.toGraph();
  assignLayers(result.nodes, result.edges);
  return result;
}
