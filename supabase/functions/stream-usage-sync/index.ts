/**
 * Hourly job (pg_cron -> pg_net, see 20261009180000_scheduled_jobs.sql).
 * Deployed with verify_jwt = false; callers must send the Vault secret
 * `keybox_cron_secret` in the x-cron-secret header (checked in the database
 * by verify_cron_secret, so the secret is never copied into function env).
 *
 * Pulls Stream "minutes delivered" for yesterday and today (UTC) from the
 * Cloudflare GraphQL Analytics API and stores them in stream_usage_daily.
 * authorize_playback() compares today's figure with app_config.daily_minutes_budget
 * to throttle free episodes before the bill runs away.
 */
import { env, json, serviceClient } from "../_shared/http.ts";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

const QUERY = `
query KeyboxStreamMinutes($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      streamMinutesViewedAdaptiveGroups(filter: { date_geq: $start, date_lt: $end }, limit: 10) {
        sum { minutesViewed }
        dimensions { date }
      }
    }
  }
}`;

function utcDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const admin = serviceClient();
    const { data: ok } = await admin.rpc("verify_cron_secret", { p_secret: req.headers.get("x-cron-secret") ?? "" });
    if (ok !== true) return json({ error: "forbidden" }, 403);

    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("CLOUDFLARE_ANALYTICS_API_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { accountTag: env("CLOUDFLARE_ACCOUNT_ID"), start: utcDate(-1), end: utcDate(1) },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await res.json() as {
      data?: { viewer?: { accounts?: { streamMinutesViewedAdaptiveGroups?: { sum: { minutesViewed: number }; dimensions: { date: string } }[] }[] } };
      errors?: { message: string }[] | null;
    };
    if (!res.ok || (payload.errors && payload.errors.length > 0)) {
      console.error("graphql failed", res.status, payload.errors?.map((e) => e.message).join("; "));
      return json({ error: "upstream_error" }, 502);
    }

    const groups = payload.data?.viewer?.accounts?.[0]?.streamMinutesViewedAdaptiveGroups ?? [];
    const byDay = new Map<string, number>([[utcDate(-1), 0], [utcDate(0), 0]]);
    for (const g of groups) byDay.set(g.dimensions.date, (byDay.get(g.dimensions.date) ?? 0) + g.sum.minutesViewed);

    for (const [day, minutes] of byDay) {
      const { error } = await admin.rpc("record_stream_usage", { p_day: day, p_minutes: minutes });
      if (error) {
        console.error("record_stream_usage failed", error.message);
        return json({ error: "server_error" }, 500);
      }
    }

    return json({ ok: true, minutes: Object.fromEntries(byDay) });
  } catch (err) {
    console.error("stream-usage-sync error", err instanceof Error ? err.message : err);
    return json({ error: "server_error" }, 500);
  }
});
