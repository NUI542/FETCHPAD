import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import css from '@shikijs/langs/css';
import html from '@shikijs/langs/html';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import jsx from '@shikijs/langs/jsx';
import python from '@shikijs/langs/python';
import sql from '@shikijs/langs/sql';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationRaw } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import * as vscode from 'vscode';
import type { CodeFile } from '../shared/protocol';

const LANG_BY_EXT: Record<string, string> = {
  '.js': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript', '.jsx': 'jsx',
  '.ts': 'typescript', '.cts': 'typescript', '.mts': 'typescript', '.tsx': 'tsx',
  '.sql': 'sql', '.py': 'python', '.html': 'html', '.css': 'css', '.json': 'json',
};

/** Colours code with the user's current VS Code theme, so previews look like their editor. */
export class Highlighter {
  private core?: Promise<HighlighterCore>;
  private theme?: string;

  async highlight(file: string, text: string, fileName: string): Promise<CodeFile> {
    const lang = LANG_BY_EXT[path.extname(fileName).toLowerCase()];
    const hl = await this.load();
    const theme = await this.currentTheme(hl);
    const { bg, fg } = hl.getTheme(theme);
    if (!lang) {
      return { file, lang: 'text', lines: text.split(/\r?\n/).map((line) => [{ text: line }]), background: bg, foreground: fg };
    }
    const lines = hl.codeToTokensBase(text, { lang, theme }).map((line) =>
      line.map((t) => ({ text: t.content, color: t.color, fontStyle: t.fontStyle || undefined })));
    return { file, lang, lines, background: bg, foreground: fg };
  }

  /** Forget the theme; the next request loads whichever one is active then. */
  themeChanged(): void {
    this.theme = undefined;
  }

  private load(): Promise<HighlighterCore> {
    this.core ??= createHighlighterCore({
      themes: [darkPlus, lightPlus],
      langs: [javascript, jsx, typescript, tsx, sql, python, html, css, json],
      engine: createJavaScriptRegexEngine(),
    });
    return this.core;
  }

  private async currentTheme(hl: HighlighterCore): Promise<string> {
    if (this.theme) return this.theme;
    const user = loadActiveTheme();
    if (user) {
      try {
        await hl.loadTheme(user);
        this.theme = user.name!;
        return this.theme;
      } catch {
        // Fall through to a bundled theme of the same brightness.
      }
    }
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    this.theme = light ? 'light-plus' : 'dark-plus';
    return this.theme;
  }
}

/** Find the active colour theme's JSON among installed and built-in extensions. */
function loadActiveTheme(): ThemeRegistrationRaw | undefined {
  const id = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (!id) return undefined;
  for (const ext of vscode.extensions.all) {
    const themes = ext.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    for (const t of themes) {
      if (t.id !== id && t.label !== id) continue;
      const theme = readThemeFile(path.join(ext.extensionPath, t.path), 0);
      if (!theme || !theme.tokenColors.length) return undefined;
      const light = t.uiTheme === 'vs' || t.uiTheme === 'hc-light';
      return { name: `vscode:${id}`, type: light ? 'light' : 'dark', colors: theme.colors, tokenColors: theme.tokenColors } as ThemeRegistrationRaw;
    }
  }
  return undefined;
}

interface ThemeFile {
  colors: Record<string, string>;
  tokenColors: unknown[];
}

/** Read a theme file, following `include` chains (Dark Modern → Dark+ → Dark). */
function readThemeFile(file: string, depth: number): ThemeFile | undefined {
  if (depth > 5) return undefined;
  let data: { include?: string; colors?: Record<string, string>; tokenColors?: unknown };
  try {
    data = parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const base = data.include ? readThemeFile(path.resolve(path.dirname(file), data.include), depth + 1) : undefined;
  return {
    colors: { ...base?.colors, ...data.colors },
    tokenColors: [...(base?.tokenColors ?? []), ...(Array.isArray(data.tokenColors) ? data.tokenColors : [])],
  };
}
