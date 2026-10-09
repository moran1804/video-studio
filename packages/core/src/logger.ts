import pino, { type Logger } from 'pino';
import { redact } from './security/redact';

let root: Logger | undefined;

export function getLogger(name?: string): Logger {
  if (!root) {
    root = pino({
      level: process.env.LOG_LEVEL || 'info',
      base: { service: process.env.SERVICE_NAME || 'studio' },
      redact: {
        paths: [
          '*.apiKey',
          '*.api_key',
          '*.password',
          '*.passwordHash',
          '*.token',
          '*.authorization',
          '*.headers.authorization',
          '*.headers["x-goog-api-key"]',
          '*.headers["xi-api-key"]',
          'req.headers.cookie',
        ],
        censor: '[REDACTED]',
      },
      hooks: {
        // Scrub secrets from the final message and any string args.
        logMethod(args, method) {
          const cleaned = args.map((a) => (typeof a === 'string' ? redact(a) : a));
          return method.apply(this, cleaned as Parameters<typeof method>);
        },
      },
      formatters: {
        log(obj) {
          if (obj.err && obj.err instanceof Error) {
            const e = obj.err as Error;
            return {
              ...obj,
              err: { name: e.name, message: redact(e.message), stack: e.stack ? redact(e.stack) : undefined },
            };
          }
          return obj;
        },
      },
    });
  }
  return name ? root.child({ module: name }) : root;
}
