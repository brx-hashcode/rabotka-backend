/**
 * The shared e5 embedder — one copy of the model for every API on the host.
 *
 * multilingual-e5-large is ~2.2GB of native memory once loaded. The prod and
 * develop APIs each loading their own made it ~4.4GB of a 12GB VPS for
 * identical vectors (measured 2026-11-24: 2.9GiB RSS per API). This process
 * holds the only copy; the APIs reach it through `VOVA_EMBEDDER_URL`
 * (`HelpEmbeddingsService` goes remote when that is set).
 *
 * It runs from the backend image — the model is already baked in — with its
 * own command and compose project (`docker-compose.embedder.yml`). Deliberately
 * not Nest: it needs a model and two routes, not the app's module graph or its
 * credentials.
 *
 * **Queries before passages.** onnxruntime runs synchronously, so one job at a
 * time is all there is. A category rebuild on one API (dozens of passages) must
 * not hold up a person's question on the other, so passage requests are cut
 * into small slices and any waiting query goes ahead of the next slice.
 *
 *   GET  /health → 200 once the model is loaded, 503 before
 *   POST /embed  { kind: 'query' | 'passage', texts: string[] } → { vectors }
 */
import { createServer, type IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HelpEmbeddingsService } from './modules/rag/retrieval/embeddings.service';
import type { QdrantService } from './modules/qdrant/qdrant.service';

// This process IS the embedder: an inherited URL would make it call itself.
delete process.env.VOVA_EMBEDDER_URL;

const logger = new Logger('Embedder');
const PORT = Number(process.env.VOVA_EMBEDDER_PORT ?? 3100);
const PASSAGE_SLICE = 4;
const MAX_TEXTS = 64;
const MAX_TEXT_CHARS = 8_000;
const MAX_BODY_BYTES = 1_000_000;

// Only the dense side is asked of this process; sparse stays with QdrantService
// in the APIs, so it never needs a Qdrant client.
const embeddings = new HelpEmbeddingsService(
  new ConfigService(),
  {} as QdrantService,
);

let ready = false;

type Job = () => Promise<void>;
const queryLane: Job[] = [];
const passageLane: Job[] = [];
let running = false;
// Requests whose body is still arriving: their lane is not known yet.
let reading = 0;

function schedule<T>(lane: Job[], work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    lane.push(() => work().then(resolve, reject));
    void pump();
  });
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = queryLane.shift() ?? passageLane.shift();
      if (!job) return;
      await job();
      // Let requests that arrived during the job be read and queued before
      // choosing the next one. A single tick is not enough — accepting the
      // connection and reading the body take several — and without this wait a
      // query arriving mid-rebuild sat behind a second slice (measured: ~4.6s
      // instead of ~2.5s). A few ms per slice of ~2s.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const deadline = Date.now() + 50;
      while (reading > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    running = false;
  }
}

async function embed(
  kind: 'query' | 'passage',
  texts: string[],
): Promise<number[][]> {
  if (kind === 'query') {
    return schedule(queryLane, () =>
      Promise.all(texts.map((text) => embeddings.embedQuery(text))),
    );
  }
  const slices: Promise<number[][]>[] = [];
  for (let i = 0; i < texts.length; i += PASSAGE_SLICE) {
    const slice = texts.slice(i, i + PASSAGE_SLICE);
    slices.push(schedule(passageLane, () => embeddings.embedPassages(slice)));
  }
  return (await Promise.all(slices)).flat();
}

class BadRequest extends Error {}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('invalid JSON');
  }
}

function parse(body: unknown): {
  kind: 'query' | 'passage';
  texts: string[];
} {
  const { kind, texts } = (body ?? {}) as { kind?: unknown; texts?: unknown };
  if (kind !== 'query' && kind !== 'passage') {
    throw new BadRequest("kind must be 'query' or 'passage'");
  }
  if (
    !Array.isArray(texts) ||
    texts.length === 0 ||
    texts.length > MAX_TEXTS ||
    !texts.every((t) => typeof t === 'string' && t.length <= MAX_TEXT_CHARS)
  ) {
    throw new BadRequest(
      `texts must be 1–${MAX_TEXTS} strings of at most ${MAX_TEXT_CHARS} chars`,
    );
  }
  return { kind, texts: texts as string[] };
}

const server = createServer((req, res) => {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (req.method === 'GET' && req.url === '/health') {
    send(ready ? 200 : 503, { ready });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/embed') {
    send(404, { error: 'not found' });
    return;
  }
  if (!ready) {
    send(503, { error: 'model loading' });
    return;
  }

  const started = Date.now();
  reading++;
  readBody(req)
    .finally(() => reading--)
    .then(parse)
    .then(async ({ kind, texts }) => {
      const vectors = await embed(kind, texts);
      const ms = Date.now() - started;
      if (ms > 5_000) {
        logger.warn(`slow ${kind} ×${texts.length}: ${ms}ms`);
      }
      send(200, { vectors });
    })
    .catch((err: unknown) => {
      if (err instanceof BadRequest) {
        send(400, { error: err.message });
        return;
      }
      logger.error('embed failed', err);
      send(500, { error: 'embed failed' });
    });
});

server.listen(PORT, '0.0.0.0', () => {
  logger.log(`Listening on :${PORT}, loading multilingual-e5-large…`);
  const started = Date.now();
  embeddings
    .warmUp()
    .then(() => {
      ready = true;
      logger.log(`Ready in ${Date.now() - started}ms`);
    })
    .catch((err: unknown) => {
      // Nothing to serve without the model; let the restart policy retry.
      logger.error('Model load failed', err);
      process.exit(1);
    });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
