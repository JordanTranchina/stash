// Minimal Sentry wrapper shared by all Edge Functions.
//
// Reporting is a no-op whenever SENTRY_DSN isn't set as a project secret, so
// every function stays fully functional without a Sentry project configured.
import * as Sentry from "https://esm.sh/@sentry/deno@8";

const dsn = Deno.env.get("SENTRY_DSN");

if (dsn) {
  Sentry.init({
    dsn,
    // The Edge Runtime can reuse one isolate across unrelated requests, so the
    // default integrations (which assume a single request per process) are
    // disabled; reportError below scopes each report to its own call instead
    // of relying on shared/global state.
    defaultIntegrations: false,
    tracesSampleRate: 0,
  });
}

// Reports an error tagged with which function it came from. Flushes
// immediately (rather than relying on a background flush) since the
// function's isolate can be frozen or torn down right after the response
// that follows this call returns.
export async function reportError(err: unknown, functionName: string): Promise<void> {
  if (!dsn) return;
  Sentry.withScope((scope) => {
    scope.setTag("function", functionName);
    Sentry.captureException(err);
  });
  await Sentry.flush(2000);
}
