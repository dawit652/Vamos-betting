/**
 * Optional OpenTelemetry tracing for the API and the worker.
 *
 * Tracing is on only when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (`config.telemetry.otlpEndpoint`). Otherwise `startTelemetry` returns a
 * no-op and never loads an @opentelemetry package (they are imported
 * dynamically, only when tracing is on). Spans are exported over OTLP/HTTP
 * (JSON) to `<endpoint>/v1/traces` in batches.
 *
 * The services create their spans through the small `Telemetry` interface
 * below (an HTTP server span per API request, a consumer span per BullMQ
 * job), so callers never depend on the OpenTelemetry API directly.
 */

export type SpanKindName = 'server' | 'consumer' | 'internal';
export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface SpanHandle {
  setAttributes(attributes: SpanAttributes): void;
  /** Records the error on the span and marks it failed. */
  recordError(error: unknown): void;
  /** Ends the span (once; later calls do nothing). */
  end(): void;
  /** The W3C trace id (32 hex characters), or null when tracing is off. */
  readonly traceId: string | null;
}

export interface Telemetry {
  readonly enabled: boolean;
  startSpan(
    name: string,
    options?: {
      kind?: SpanKindName;
      attributes?: SpanAttributes;
      /** An incoming W3C `traceparent` header: the span joins that trace. */
      traceparent?: string | undefined;
    },
  ): SpanHandle;
  /** Flushes the pending spans and stops exporting. */
  shutdown(): Promise<void>;
}

const NOOP_SPAN: SpanHandle = {
  setAttributes: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
  traceId: null,
};

export const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  startSpan: () => NOOP_SPAN,
  shutdown: () => Promise.resolve(),
};

function definedAttributes(
  attributes: SpanAttributes | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The OTLP/HTTP traces URL of a base endpoint (as OTEL_EXPORTER_OTLP_ENDPOINT defines it). */
export function otlpTracesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

/**
 * Starts tracing when `telemetry.otlpEndpoint` is set; the no-op otherwise.
 * `serviceName` is the default service name (OTEL_SERVICE_NAME overrides it).
 */
export async function startTelemetry(
  config: { telemetry: { otlpEndpoint: string | undefined; serviceName: string | undefined } },
  serviceName: string,
): Promise<Telemetry> {
  const endpoint = config.telemetry.otlpEndpoint;
  if (endpoint === undefined) return NOOP_TELEMETRY;

  const [api, core, base, exporter, resources] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/core'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
  ]);
  const provider = new base.BasicTracerProvider({
    resource: resources.resourceFromAttributes({
      'service.name': config.telemetry.serviceName ?? serviceName,
    }),
    spanProcessors: [
      new base.BatchSpanProcessor(new exporter.OTLPTraceExporter({ url: otlpTracesUrl(endpoint) })),
    ],
  });
  const tracer = provider.getTracer('vamos');
  const propagator = new core.W3CTraceContextPropagator();
  const kinds = {
    server: api.SpanKind.SERVER,
    consumer: api.SpanKind.CONSUMER,
    internal: api.SpanKind.INTERNAL,
  } as const;

  return {
    enabled: true,
    startSpan(name, options = {}) {
      const parent =
        options.traceparent === undefined
          ? api.ROOT_CONTEXT
          : propagator.extract(
              api.ROOT_CONTEXT,
              { traceparent: options.traceparent },
              api.defaultTextMapGetter,
            );
      const span = tracer.startSpan(
        name,
        {
          kind: kinds[options.kind ?? 'internal'],
          attributes: definedAttributes(options.attributes),
        },
        parent,
      );
      let ended = false;
      return {
        traceId: span.spanContext().traceId,
        setAttributes: (attributes) => {
          span.setAttributes(definedAttributes(attributes));
        },
        recordError: (error) => {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({
            code: api.SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
        },
        end: () => {
          if (ended) return;
          ended = true;
          span.end();
        },
      };
    },
    shutdown: () => provider.shutdown(),
  };
}
