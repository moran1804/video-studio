// Used by the Docker HEALTHCHECK: exits 0 when the worker health endpoint is OK.
const port = process.env.WORKER_HEALTH_PORT || '3001';
fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) })
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
