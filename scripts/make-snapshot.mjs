// Regenerates the bundled snapshots from Models.dev and The Model Index. Run after `npm run build`.
// Pass `models` or `scores` to regenerate only one of them.
import { mkdir, writeFile } from 'node:fs/promises';
import { fetchUpstreamRatings } from '../dist/placements/sources/modelindex.js';
import { fetchModelIndex } from '../dist/placements/sources/modelsdev.js';

const only = process.argv[2];

async function write(name, data) {
  const out = new URL(`../data/${name}`, import.meta.url);
  const json = JSON.stringify({ fetchedAt: Date.now(), ...data }, null, 2) + '\n';
  await mkdir(new URL('.', out), { recursive: true });
  await writeFile(out, json);
  return json.length;
}

if (only !== 'scores') {
  const index = await fetchModelIndex();
  console.log(`models-snapshot.json: ${Object.keys(index).length} models, ${await write('models-snapshot.json', { index })} bytes`);
}
if (only !== 'models') {
  // The Model Index (themodelindex.org), CC BY 4.0.
  const ratings = await fetchUpstreamRatings();
  console.log(`modelindex-snapshot.json: ${ratings.length} rated models, ${await write('modelindex-snapshot.json', { ratings })} bytes`);
}
