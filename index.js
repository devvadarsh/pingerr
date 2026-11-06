// Pingerr — pings your URLs every 14 minutes and emails you the moment one fails.
require("dotenv").config();
const http = require("http");
const { send } = require("./mail");

const EVERY = 14 * 60 * 1000;   // fixed: 14 minutes
const TIMEOUT = 60 * 1000;      // slow-waking hosts (e.g. free Render) can take ~50s
const targets = (process.env.URLS || "").split(",").map(s => s.trim()).filter(u => /^https?:\/\//.test(u));
const state = new Map(targets.map(u => [u, { up: true, since: null, last: null, detail: "not checked yet" }]));

async function check(url) {
  const s = state.get(url); let ok = false, detail;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Pingerr/1.0" }, signal: AbortSignal.timeout(TIMEOUT) });
    ok = r.ok; detail = `HTTP ${r.status}`;
  } catch (e) { detail = e.name === "TimeoutError" ? "timed out after 60s" : (e.cause && e.cause.code) || e.message; }
  const now = new Date().toISOString(); s.last = now; s.detail = detail;
  console.log(`[${now}] ${ok ? "UP  " : "DOWN"} ${url} (${detail})`);
  if (!ok && s.up) {            // went down: email instantly
    s.up = false; s.since = now;
    await send(`[Pingerr] DOWN: ${url}`, `Pingerr could not reach:\n${url}\n\nTime: ${now}\nReason: ${detail}\n\nYou will get one more email when it comes back up. It is checked every 14 minutes.`);
  } else if (ok && !s.up) {     // came back
    const since = s.since; s.up = true; s.since = null;
    await send(`[Pingerr] RECOVERED: ${url}`, `${url} is reachable again (${detail}).\nIt was down since ${since}.\nRecovered at ${now}.`);
  }
}
const round = () => Promise.all(targets.map(check));

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Pingerr is running. Interval: 14 min.\n\n` + targets.map(u => `${state.get(u).up ? "UP  " : "DOWN"} ${u} — ${state.get(u).detail} (${state.get(u).last || "-"})`).join("\n"));
}).listen(process.env.PORT || 3000);

if (!targets.length) console.error("Set URLS in .env (comma-separated http/https URLs).");
else { console.log(`Pingerr watching ${targets.length} URL(s) every 14 min.`); round(); setInterval(round, EVERY); }
