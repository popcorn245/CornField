/**
 * The explorer's stylesheets, as the tests read them (spec 0011 D8): explorer.css was split into one file per piece, explorer/css/*.css, and the page links
 * them in an order that is its cascade (explorer/index.html). A test that asks "does the explorer's CSS say this" reads them together, in that order;
 * one that asks about a file reads that file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXPLORER_DIR = path.resolve(here, '../../explorer');
export const CSS_DIR = path.join(EXPLORER_DIR, 'css');

/** The files of explorer/css/, as the page links them, in order (index.html's `<link>` lines), as bare names: `['base.css', ..., 'page.css']` */
export function linkedPieces() {
  const html = fs.readFileSync(path.join(EXPLORER_DIR, 'index.html'), 'utf8');
  return [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="\/explorer\/css\/([\w.-]+\.css)"/g)].map((m) => m[1]);
}

/** Every file in explorer/css/, sorted (what is on disk, linked or not) */
export function pieceFiles() {
  return fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).sort();
}

export const readPiece = (name) => fs.readFileSync(path.join(CSS_DIR, name), 'utf8');

/**
 * The text of some stylesheets, joined: `'explorer.css'` stands for all the pieces' files in link order (what explorer.css was), any other name is a
 * file of explorer/ (`'tokens.css'`, `'house.css'`). `stripComments` drops the comments.
 */
export function explorerCss(names = ['explorer.css'], { stripComments = false } = {}) {
  const parts = [];
  for (const n of names) {
    if (n === 'explorer.css') for (const f of linkedPieces()) parts.push(readPiece(f));
    else parts.push(fs.readFileSync(path.join(EXPLORER_DIR, n), 'utf8'));
  }
  const text = parts.join('\n');
  return stripComments ? text.replace(/\/\*[\s\S]*?\*\//g, '') : text;
}
