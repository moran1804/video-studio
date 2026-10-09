/**
 * Secret redaction for logs and user-visible error messages.
 * Known secret values are registered at startup; common key formats are
 * scrubbed by pattern as a second line of defence.
 */
const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI style
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /key_[A-Za-z0-9]{32,}/g, // Runway style
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(x-goog-api-key|xi-api-key|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi,
  /([?&](?:key|api_key|token)=)[^&\s]+/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const p of PATTERNS) {
    out = out.replace(p, (match, g1?: string, g2?: string) => {
      if (typeof g1 === 'string' && typeof g2 === 'string') return `${g1}${g2}[REDACTED]`;
      if (typeof g1 === 'string' && /^(Bearer\s+|[?&])/i.test(g1)) return `${g1}[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}

export function redactError(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
