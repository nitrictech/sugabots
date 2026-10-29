/**
 * The HTML page Researcher makes in the showcase: a one-page comparison of
 * three Postgres job queues. Coloured with the app's CSS variables and with a
 * transparent background, as the artifact tool asks of a bot's pages.
 */
export const QUEUE_REPORT_TITLE = "Postgres job queues for exports";

export const QUEUE_REPORT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; padding: 24px; background: transparent; color: var(--body-foreground); font: 15px/1.55 var(--font-sans); }
  h1 { margin: 0 0 4px; color: var(--foreground); font-size: 22px; letter-spacing: -0.01em; }
  .lede { margin: 0 0 20px; color: var(--muted-foreground); }
  .pick { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; margin-bottom: 20px; border-radius: 12px; background: var(--chip); }
  .pick strong { color: var(--foreground); }
  .badge { flex: none; padding: 2px 8px; border-radius: 6px; background: var(--primary); color: #fff; font-size: 12px; font-weight: 600; }
  .table { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 10px 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
  thead th { color: var(--muted-foreground); font-weight: 500; font-size: 13px; }
  tbody th { color: var(--foreground); font-weight: 600; white-space: nowrap; }
  tr:last-child th, tr:last-child td { border-bottom: 0; }
  .yes { color: var(--success-text); }
  .no { color: var(--subtle-foreground); }
  h2 { margin: 24px 0 8px; color: var(--foreground); font-size: 16px; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; }
  code { font: 13px var(--font-mono); background: var(--chip); padding: 1px 5px; border-radius: 5px; }
</style>
</head>
<body>
  <h1>Postgres job queues for exports</h1>
  <p class="lede">Three ways to move the export job off cron and onto a queue in the database we already run.</p>

  <div class="pick">
    <span class="badge">Pick</span>
    <span><strong>Graphile Worker.</strong> It wakes on <code>LISTEN/NOTIFY</code> instead of polling, has cron built in, and retries with backoff, so it covers the export job with no new infrastructure.</span>
  </div>

  <div class="table">
    <table>
      <thead>
        <tr><th></th><th>Graphile Worker</th><th>pg-boss</th><th>pgmq</th></tr>
      </thead>
      <tbody>
        <tr><th>Runs as</th><td>Node library</td><td>Node library</td><td>Postgres extension</td></tr>
        <tr><th>Picks up new jobs</th><td>LISTEN/NOTIFY</td><td>Polling</td><td>Polling, from any language</td></tr>
        <tr><th>Scheduled jobs</th><td class="yes">Built-in crontab</td><td class="yes">Built-in cron</td><td class="no">Needs pg_cron</td></tr>
        <tr><th>Retries and backoff</th><td class="yes">Built in</td><td class="yes">Built in</td><td class="no">Visibility timeout only</td></tr>
        <tr><th>Fits the export job</th><td class="yes">Yes</td><td class="yes">Yes</td><td class="no">Needs more around it</td></tr>
      </tbody>
    </table>
  </div>

  <h2>Next steps</h2>
  <ul>
    <li>Move <code>ExportJob</code> into a Graphile Worker task, keeping its retries at 5.</li>
    <li>Replace the nightly cron entry with a crontab line in the worker.</li>
    <li>Give each export a timeout, as Code Reviewer flagged on #482.</li>
  </ul>
</body>
</html>
`;
