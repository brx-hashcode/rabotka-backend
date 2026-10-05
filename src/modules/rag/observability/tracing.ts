import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Logger } from '@nestjs/common';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { maskPii } from './pii-mask';

const logger = new Logger('VovaTracing');

async function loadSdks() {
  const [{ NodeSDK }, { LangfuseSpanProcessor }, tracing, lc, client] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@langfuse/otel'),
      import('@langfuse/tracing'),
      import('@langfuse/langchain'),
      import('@langfuse/client'),
    ]);
  return {
    NodeSDK,
    LangfuseSpanProcessor,
    tracing,
    CallbackHandler: lc.CallbackHandler,
    LangfuseClient: client.LangfuseClient,
  };
}

type Sdks = Awaited<ReturnType<typeof loadSdks>>;

interface TracingState {
  tracing: Sdks['tracing'];
  CallbackHandler: Sdks['CallbackHandler'];
  client: InstanceType<Sdks['LangfuseClient']>;
  sampleRate: number;
}

let state: TracingState | null = null;
let stopSdk: (() => Promise<void>) | null = null;
let starting: Promise<void> | null = null;

export function isTracingConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    env.LANGFUSE_PUBLIC_KEY?.trim() && env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

export function tracingEnv(
  env: NodeJS.ProcessEnv = process.env,
  files: string[] = ['.env.local', '.env'],
): NodeJS.ProcessEnv {
  const fromFiles: Record<string, string> = {};
  for (const file of [...files].reverse()) {
    try {
      if (!existsSync(file)) continue;
      for (const [k, v] of Object.entries(parse(readFileSync(file)))) {
        if (/^(LANGFUSE_|VOVA_TRACE_)/.test(k) && v !== '') fromFiles[k] = v;
      }
    } catch {
      /* an unreadable file is the same as a missing one */
    }
  }
  return { ...fromFiles, ...env };
}

export async function initVovaTracing(
  env: NodeJS.ProcessEnv = tracingEnv(),
): Promise<boolean> {
  if (state) return true;
  if (!isTracingConfigured(env)) return false;
  starting ??= (async () => {
    try {
      const sdks = await loadSdks();

      const sdk = new sdks.NodeSDK({
        instrumentations: [],
        spanProcessors: [
          new sdks.LangfuseSpanProcessor({
            publicKey: env.LANGFUSE_PUBLIC_KEY,
            secretKey: env.LANGFUSE_SECRET_KEY,
            baseUrl: env.LANGFUSE_BASE_URL,
            mask: ({ data }) => maskPii(data),
            environment: env.LANGFUSE_TRACING_ENVIRONMENT || env.NODE_ENV,
            release: env.APP_VERSION,
          }),
        ],
      });
      sdk.start();

      const rate = Number(env.VOVA_TRACE_SAMPLE_RATE ?? '1');
      const ready: TracingState = {
        tracing: sdks.tracing,
        CallbackHandler: sdks.CallbackHandler,
        client: new sdks.LangfuseClient({
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
          baseUrl: env.LANGFUSE_BASE_URL,
        }),
        sampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 1,
      };
      state = ready;

      stopSdk = async () => {
        await Promise.allSettled([ready.client.score.flush(), sdk.shutdown()]);
      };
      const stop = () => {
        void stopSdk?.();
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);

      logger.log(
        `Langfuse tracing on (${env.LANGFUSE_BASE_URL ?? 'default host'}, sample=${ready.sampleRate})`,
      );
    } catch (err) {
      state = null;
      logger.warn(
        `Langfuse tracing could not start; VoVa runs untraced: ${String(err)}`,
      );
    }
  })();
  await starting;
  return state !== null;
}

export function anonymousTraceUser(phone: string): string {
  return `anon_${createHash('sha256').update(phone).digest('hex').slice(0, 16)}`;
}

export interface TurnTrace {
  input: string;
  userId: string;
  sessionId?: string;
  tags: string[];
}

export interface TurnHandle {
  end(output: unknown, metadata?: Record<string, unknown>): void;
  score(name: string, value: number, comment?: string): void;
}

const NOOP_TURN: TurnHandle = { end: () => undefined, score: () => undefined };

export async function traceVovaTurn<T>(
  name: string,
  meta: TurnTrace,
  fn: (turn: TurnHandle) => Promise<T>,
): Promise<T> {
  const s = state;
  if (!s || Math.random() >= s.sampleRate) return fn(NOOP_TURN);

  return s.tracing.propagateAttributes(
    {
      userId: meta.userId,
      sessionId: meta.sessionId,
      tags: meta.tags,
      traceName: name,
    },
    () =>
      s.tracing.startActiveObservation(
        name,
        async (span) => {
          span.update({ input: meta.input });
          const handle: TurnHandle = {
            end: (output, metadata) => {
              try {
                span.update({ output, metadata });
              } catch {
                /* tracing must never break a reply */
              }
            },
            score: (scoreName, value, comment) => {
              try {
                s.client.score.activeTrace({ name: scoreName, value, comment });
              } catch {
                /* idem */
              }
            },
          };
          return fn(handle);
        },
        { asType: 'agent' },
      ),
  );
}

export async function traceAgentRun<T>(
  meta: { provider: string; model?: string; hedge: boolean; position: number },
  fn: () => Promise<T>,
): Promise<T> {
  const s = state;
  if (!s) return fn();
  return s.tracing.startActiveObservation(
    `vova.run.${meta.provider}`,
    async (span) => {
      span.update({ metadata: { ...meta } });
      try {
        const out = await fn();
        span.update({ metadata: { ...meta, outcome: 'completed' } });
        return out;
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        span.update({
          level: aborted ? 'DEFAULT' : 'ERROR',
          statusMessage: err instanceof Error ? err.message : String(err),
          metadata: { ...meta, outcome: aborted ? 'aborted' : 'failed' },
        });
        throw err;
      }
    },
    { asType: 'chain' },
  );
}

export function vovaCallbacks(): BaseCallbackHandler[] {
  const s = state;
  if (!s) return [];
  try {
    return [new s.CallbackHandler() as unknown as BaseCallbackHandler];
  } catch {
    return [];
  }
}

export function scoreActiveTurn(
  name: string,
  value: number,
  comment?: string,
): void {
  const s = state;
  if (!s) return;
  try {
    s.client.score.activeTrace({ name, value, comment });
  } catch {
    /* tracing must never break a reply */
  }
}

export function vovaLangfuseClient(): TracingState['client'] | null {
  return state?.client ?? null;
}

export async function shutdownVovaTracing(): Promise<void> {
  await stopSdk?.();
}

export function resetVovaTracingForTests(): void {
  state = null;
  starting = null;
}
