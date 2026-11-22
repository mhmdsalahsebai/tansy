// Netlify stops a function once it has answered, so the CMS's timers never fire there. This
// scheduled function calls the background endpoint every five minutes instead, as Vercel Cron
// does: publishing at a set time, webhooks, search indexing and the rest of background work.
// TANSY_BACKGROUND_SECONDS keeps each call inside Netlify's function time limit.
export default async () => {
  const site = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!site || !secret) return new Response("Set CRON_SECRET.", { status: 503 });
  const response = await fetch(`${site}/api/background`, { headers: { authorization: `Bearer ${secret}` } });
  return new Response(null, { status: response.status });
};

export const config = { schedule: "*/5 * * * *" };
