// Builds a standalone page that runs the map webview outside VS Code, with a
// stand-in for the VS Code API, so the UI can be checked in any browser. It
// applies the same script policy as the real webview (nonce only, no eval).
//   npm run build && npm run harness -- [project-dir]
// Then open .fetchpad/harness/index.html.
import * as fs from 'fs';
import * as path from 'path';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { analyze } from '../src/engine/analyze';
import type { CodeFile } from '../src/shared/protocol';

const LANG_BY_EXT: Record<string, string> = {
  '.js': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript', '.jsx': 'jsx',
  '.ts': 'typescript', '.tsx': 'tsx', '.sql': 'sql',
};

// The Dark Modern colours the webview reads from VS Code.
const VSCODE_VARS: Record<string, string> = {
  'font-family': '-apple-system, "Segoe UI", sans-serif',
  'font-size': '13px',
  'editor-font-family': 'Consolas, "Courier New", monospace',
  'editor-font-size': '13px',
  'editor-background': '#1f1f1f',
  'editor-foreground': '#cccccc',
  descriptionForeground: '#9d9d9d',
  'editorWidget-background': '#202020',
  'editorWidget-border': '#313131',
  'panel-border': '#2b2b2b',
  'sideBar-background': '#181818',
  focusBorder: '#0078d4',
  'toolbar-hoverBackground': '#5a5d5e50',
  'button-background': '#0078d4',
  'button-foreground': '#ffffff',
  'input-background': '#313131',
  'input-foreground': '#cccccc',
  'input-border': '#3c3c3c',
  'list-hoverBackground': '#2a2d2e',
  'list-activeSelectionBackground': '#04395e',
  'list-activeSelectionForeground': '#ffffff',
  'editorLineNumber-foreground': '#6e7681',
  'editorLineNumber-activeForeground': '#cccccc',
  'editorIndentGuide-background1': '#404040',
  'editorGroupHeader-tabsBackground': '#181818',
  'editor-foldBackground': '#264f7840',
  'widget-shadow': '#00000066',
  'icon-foreground': '#cccccc',
  errorForeground: '#f85149',
  'editorWarning-foreground': '#cca700',
  'charts-blue': '#3794ff',
  'charts-green': '#89d185',
  'charts-orange': '#d18616',
  'charts-purple': '#b180d7',
  'charts-red': '#f14c4c',
  'charts-yellow': '#cca700',
};

async function main(): Promise<void> {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'test', 'fixtures', 'mini-app'));
  const out = path.join(__dirname, '..', '.fetchpad', 'harness');
  fs.mkdirSync(out, { recursive: true });

  const graph = analyze(root);
  const hl = await createHighlighterCore({
    themes: [import('@shikijs/themes/dark-plus')],
    langs: [import('@shikijs/langs/javascript'), import('@shikijs/langs/jsx'), import('@shikijs/langs/typescript'),
      import('@shikijs/langs/tsx'), import('@shikijs/langs/sql')],
    engine: createJavaScriptRegexEngine(),
  });
  const { bg, fg } = hl.getTheme('dark-plus');
  const files = new Set(graph.nodes.flatMap((n) => n.ranges.map((r) => r.file)));
  const code: Record<string, CodeFile> = {};
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const lang = LANG_BY_EXT[path.extname(file)] ?? 'text';
    const lines = lang === 'text'
      ? text.split(/\r?\n/).map((l) => [{ text: l }])
      : hl.codeToTokensBase(text, { lang, theme: 'dark-plus' }).map((line) => line.map((t) => ({ text: t.content, color: t.color })));
    code[file] = { file, lang, lines, background: bg, foreground: fg };
  }

  const vars = Object.entries(VSCODE_VARS).map(([k, v]) => `--vscode-${k}: ${v};`).join('\n  ');
  const data = JSON.stringify({ graph, code }).replace(/</g, '\\u003c');
  fs.copyFileSync(path.join(__dirname, '..', 'dist', 'webview.js'), path.join(out, 'webview.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'dist', 'webview.css'), path.join(out, 'webview.css'));
  fs.writeFileSync(path.join(out, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src * 'unsafe-inline'; script-src 'nonce-harness'">
<title>Fetchpad harness</title>
<style>:root {\n  ${vars}\n}</style>
<link rel="stylesheet" href="webview.css">
</head>
<body>
<div id="root"></div>
<script nonce="harness">
window.__FP__ = ${data};
window.__FP_SENT__ = [];
function acquireVsCodeApi() {
  let state;
  const reply = (msg) => setTimeout(() => window.postMessage(msg, '*'), 5);
  return {
    getState: () => state,
    setState: (s) => { state = s; },
    postMessage: (msg) => {
      window.__FP_SENT__.push(msg);
      if (msg.type === 'ready' || msg.type === 'refresh') {
        reply({ type: 'graph', graph: window.__FP__.graph, stats: { ms: 420, at: Date.now() } });
        reply({ type: 'status', state: 'idle' });
      } else if (msg.type === 'code') {
        const code = window.__FP__.code[msg.file];
        reply(code ? { type: 'code', requestId: msg.requestId, code } : { type: 'code', requestId: msg.requestId, error: 'No such file' });
      }
    },
  };
}
</script>
<script nonce="harness" src="webview.js"></script>
</body>
</html>`);
  console.log(`Harness for ${root}\n  ${path.join(out, 'index.html')}`);
}

void main();
