import { FlagEmbedding, EmbeddingModel, SparseTextEmbedding, SparseEmbeddingModel } from 'fastembed';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'local_cache');

console.log(`Pre-downloading fastembed models to ${cacheDir}`);

console.log('Downloading dense model (BGE Small EN v1.5)…');
const dense = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir });
for await (const _ of dense.embed(['warmup'])) { break; }
console.log('Dense model ready.');

console.log('Downloading sparse model (SPLADE PP En v1)…');
const sparse = await SparseTextEmbedding.init({ model: SparseEmbeddingModel.SpladePPEnV1, cacheDir });
for await (const _ of sparse.embed(['warmup'])) { break; }
console.log('Sparse model ready.');

console.log('All models pre-downloaded successfully.');
