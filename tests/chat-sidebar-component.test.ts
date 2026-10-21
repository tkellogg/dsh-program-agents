import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('copyable React sidebar bundles browser-only; idle SSR never reads page context or bridge credentials', async () => {
  const result = await build({ entryPoints: ['skills/program-agents/references/chat-sidebar/AgentSidebar.tsx'], bundle: true, platform: 'browser', format: 'esm', write: false, outfile: 'sidebar.js', external: ['react'] });
  const source = result.outputFiles.find(file => file.path.endsWith('sidebar.js'))!.text;
  for (const serverOnly of ['DSH_PROGRAM_BRIDGE_TOKEN', 'DSH_PROGRAM_BRIDGE_URL', 'connectProgram', 'node:crypto', 'node:sqlite']) assert.equal(source.includes(serverOnly), false, serverOnly);
  // esbuild extracts CSS as a second output; no CSS loader is needed to import this module for SSR.
  const component = await import('data:text/javascript;base64,' + Buffer.from(source.replace('from "react"', `from ${JSON.stringify(import.meta.resolve('react'))}`)).toString('base64'));
  let snapshots = 0;
  const html = renderToStaticMarkup(createElement(component.AgentSidebar, { getPageContext: () => { snapshots++; return { state: { secret: 'never read in a render' } }; } }));
  assert.equal(snapshots, 0);
  assert.ok(html.includes('Idle. Open chat'));
  assert.ok(html.includes('Show model-provided reasoning'));
  assert.equal(html.includes('never read in a render'), false);
  assert.ok(html.includes('Only a snapshot at Send is shared'));
});

test('frontend text renderer never uses an HTML escape hatch', async () => {
  const source = await readFile(new URL('../skills/program-agents/references/chat-sidebar/AgentSidebar.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes('dangerouslySetInnerHTML'), false);
  assert.equal(source.includes('innerHTML'), false);
  assert.ok(source.includes('<pre>{block.arguments}</pre>'));
  assert.ok(source.includes('<p key={index}>{block.text}</p>'));
});
