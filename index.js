// Pingerr: pings your URLs every 14 minutes and emails you the moment one fails.
// Anyone can also add their own *.onrender.com site (no login) and it gets pinged too.
// NEW: Supabase keep-alive vault. Anyone can add a *.supabase.co project plus its anon key.
// The key is encrypted (AES-256-GCM) before it is saved and the project gets one request per day.
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { send } = require("./mail");

const EVERY = 14 * 60 * 1000;                 // fixed: 14 minutes
const TIMEOUT = 60 * 1000;                    // slow-waking hosts (free Render) can take ~50s
const MAX_PUBLIC = +process.env.MAX_PUBLIC || 200;           // cap on public sites
const PER_IP_PER_HOUR = +process.env.PER_IP_PER_HOUR || 5;   // submissions per IP per hour
const DROP_AFTER = 7 * 24 * 60 * 60 * 1000;   // public sites down this long are removed
const DATA_FILE = process.env.DATA_FILE || "public-sites.json";

// ---- Supabase vault settings ----
const SB_EVERY = 24 * 60 * 60 * 1000;         // one request per day per project
const SB_TIMEOUT = 20 * 1000;
const MAX_SUPABASE = +process.env.MAX_SUPABASE || 100;
const SB_FILE = process.env.SB_DATA_FILE || "supabase-sites.json";
// Secret used to encrypt saved keys. Generate one with: openssl rand -hex 32
const VAULT_KEY = process.env.ENCRYPTION_KEY
  ? crypto.createHash("sha256").update(String(process.env.ENCRYPTION_KEY)).digest()
  : null;

// url -> { url, owner, up, since, last, detail, ms, added }
const sites = new Map();
const addSite = (url, owner, added = new Date().toISOString()) =>
  sites.set(url, { url, owner, up: true, since: null, last: null, detail: "waiting for first ping", ms: null, added });

// Your own sites (from .env). These send you email alerts.
(process.env.URLS || "").split(",").map(s => s.trim()).filter(u => /^https?:\/\//.test(u)).forEach(u => addSite(u, true));

// Public sites, restored from disk. Note: free hosts with a temporary disk lose this file on redeploy.
try {
  for (const p of JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))) {
    const u = normalize(p.url);
    if (u && !sites.has(u)) addSite(u, false, p.added);
  }
} catch (_) { /* no file yet */ }

function savePublic() {
  const list = [...sites.values()].filter(s => !s.owner).map(s => ({ url: s.url, added: s.added }));
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(list)); } catch (e) { console.error("[save] failed:", e.message); }
}

// Only https://<name>.onrender.com[/path] is accepted. No ports, no logins in the URL.
function normalize(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!/^[a-z0-9-]+\.onrender\.com$/.test(u.hostname)) return null;
  u.hash = "";
  return u.toString();
}

let nextAt = Date.now() + EVERY;

async function check(s) {
  let ok = false, detail;
  const t0 = Date.now();
  try {
    // redirect:"manual" so a public site can never bounce Pingerr to some other address
    const r = await fetch(s.url, { headers: { "User-Agent": "Pingerr/1.0" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    ok = r.status < 400; detail = `HTTP ${r.status}`;
    try { await r.body?.cancel(); } catch (_) {}
  } catch (e) { detail = e.name === "TimeoutError" ? "timed out after 60s" : (e.cause && e.cause.code) || e.message; }
  const now = new Date().toISOString();
  s.last = now; s.detail = detail; s.ms = ok ? Date.now() - t0 : null;
  console.log(`[${now}] ${ok ? "UP  " : "DOWN"} ${s.url} (${detail})`);

  if (!ok && s.up) {            // went down
    s.up = false; s.since = now;
    if (s.owner) await send(`[Pingerr] DOWN: ${s.url}`, `Pingerr could not reach:\n${s.url}\n\nTime: ${now}\nReason: ${detail}\n\nYou will get one more email when it comes back up. It is checked every 14 minutes.`);
  } else if (ok && !s.up) {     // came back
    const since = s.since; s.up = true; s.since = null;
    if (s.owner) await send(`[Pingerr] RECOVERED: ${s.url}`, `${s.url} is reachable again (${detail}).\nIt was down since ${since}.\nRecovered at ${now}.`);
  } else if (!ok && !s.owner && s.since && Date.now() - new Date(s.since) > DROP_AFTER) {
    sites.delete(s.url); savePublic();   // dead for a week: stop pinging it
    console.log("[drop] removed dead public site:", s.url);
  }
}

const round = () => { nextAt = Date.now() + EVERY; return Promise.all([...sites.values()].map(check)); };

// =====================================================================
//  SUPABASE KEEP-ALIVE VAULT
// =====================================================================
// url -> { url, table, enc, plainKey, owner, up, since, last, detail, ms, added }
//   enc      = AES-256-GCM encrypted key (public submissions, kept in memory and on disk)
//   plainKey = only for YOUR project from .env (never written to disk by Pingerr)
const sbs = new Map();
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const sbAdd = (url, props) => {
  const s = Object.assign({ url, table: "", owner: false, up: true, since: null, last: null, detail: "waiting for first ping", ms: null, added: new Date().toISOString() }, props);
  sbs.set(url, s);
  return s;
};

// AES-256-GCM. The project URL is bound in as "additional authenticated data",
// so an encrypted key cannot be swapped onto a different project.
function seal(plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", VAULT_KEY, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function unseal(b64, aad) {
  const b = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", VAULT_KEY, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
const keyOf = s => s.plainKey || unseal(s.enc, s.url);

// Only https://<20-letter-project-ref>.supabase.co is accepted. Returns the clean origin.
function sbNormalize(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!/^[a-z0-9]{20}\.supabase\.co$/.test(u.hostname)) return null;
  return `https://${u.hostname}`;
}

// Accept anon / publishable keys only. Refuse anything that looks like an admin key.
function checkKey(key) {
  if (!key || key.length < 20 || key.length > 600 || !/^[\w.\-]+$/.test(key)) return { ok: false, reason: "That does not look like a Supabase key." };
  if (key.startsWith("sb_secret_")) return { ok: false, reason: "That is a secret key. Never share it. Use the anon / publishable key instead." };
  if (key.startsWith("sb_publishable_")) return { ok: true };
  const parts = key.split(".");
  if (parts.length !== 3) return { ok: false, reason: "That does not look like a Supabase key." };
  let role;
  try { role = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role; } catch (_) { return { ok: false, reason: "That does not look like a Supabase key." }; }
  if (role === "service_role") return { ok: false, reason: "That is the service_role key. Never share it. Use the anon key instead." };
  if (role !== "anon") return { ok: false, reason: "Use the anon (public) key of your project." };
  return { ok: true };
}

// One real request to the project. With a table name it runs a tiny database read (best).
async function probe(url, table, key) {
  const t0 = Date.now();
  const headers = { apikey: key, "User-Agent": "Pingerr/1.0" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;   // new-style keys are not JWTs
  const path = table ? `/rest/v1/${table}?select=*&limit=1` : "/auth/v1/settings";
  let ok = false, detail;
  try {
    const r = await fetch(url + path, { headers, redirect: "manual", signal: AbortSignal.timeout(SB_TIMEOUT) });
    ok = r.status < 400;
    detail = r.status === 401 || r.status === 403 ? "key rejected"
      : r.status === 404 && table ? "table not found"
      : `HTTP ${r.status}`;
    try { await r.body?.cancel(); } catch (_) {}
  } catch (e) { detail = e.name === "TimeoutError" ? "timed out" : (e.cause && e.cause.code) || "unreachable"; }
  return { ok, detail, ms: ok ? Date.now() - t0 : null };
}

function saveSb() {
  const list = [...sbs.values()].filter(s => !s.owner).map(s => ({ url: s.url, table: s.table, enc: s.enc, added: s.added }));
  try { fs.writeFileSync(SB_FILE, JSON.stringify(list), { mode: 0o600 }); } catch (e) { console.error("[sb save] failed:", e.message); }
}

// Your own project from .env (optional). Emails you if it fails.
{
  const u = sbNormalize(process.env.SUPABASE_URL || ""), k = (process.env.SUPABASE_ANON_KEY || "").trim();
  const t = (process.env.SUPABASE_TABLE || "").trim();
  if (u && k && (!t || TABLE_RE.test(t))) sbAdd(u, { owner: true, plainKey: k, table: t });
}

// Public projects, restored from disk (only possible when the vault secret is set).
try {
  const saved = JSON.parse(fs.readFileSync(SB_FILE, "utf8"));
  if (!VAULT_KEY && saved.length) console.error("[vault] ENCRYPTION_KEY is not set, saved Supabase projects are NOT loaded.");
  else for (const p of saved) {
    const u = sbNormalize(p.url);
    if (!u || sbs.has(u) || !p.enc) continue;
    try { unseal(p.enc, u); } catch (_) { console.error("[vault] could not decrypt an entry (wrong ENCRYPTION_KEY?), skipped"); continue; }
    sbAdd(u, { enc: p.enc, table: TABLE_RE.test(p.table || "") ? p.table : "", added: p.added });
  }
} catch (_) { /* no file yet */ }

async function sbCheck(s) {
  let r;
  try { r = await probe(s.url, s.table, keyOf(s)); } catch (_) { r = { ok: false, detail: "vault error", ms: null }; }
  const now = new Date().toISOString();
  s.last = now; s.detail = r.detail; s.ms = r.ms;
  console.log(`[${now}] SB ${r.ok ? "UP  " : "DOWN"} ${maskUrl(s.url)} (${r.detail})`);   // never log the key

  if (!r.ok && s.up) {
    s.up = false; s.since = now;
    if (s.owner) await send(`[Pingerr] SUPABASE DOWN: ${maskUrl(s.url)}`, `The daily Supabase ping failed.\n\nProject: ${s.url}\nTime: ${now}\nReason: ${r.detail}\n\nIf the project is paused, restore it in the Supabase dashboard.`);
  } else if (r.ok && !s.up) {
    s.up = true; s.since = null;
    if (s.owner) await send(`[Pingerr] SUPABASE OK AGAIN: ${maskUrl(s.url)}`, `The Supabase ping works again (${r.detail}) at ${now}.`);
  } else if (!r.ok && !s.owner && s.since && Date.now() - new Date(s.since) > DROP_AFTER) {
    sbs.delete(s.url); saveSb();
    console.log("[drop] removed dead supabase project:", maskUrl(s.url));
  }
}

let sbNextAt = Date.now() + SB_EVERY;
const sbRound = () => { sbNextAt = Date.now() + SB_EVERY; return Promise.all([...sbs.values()].map(sbCheck)); };

// Public pages show a masked name, never the full project address.
function maskUrl(url) {
  const ref = new URL(url).hostname.split(".")[0];
  return `${ref.slice(0, 4)}...${ref.slice(-3)}.supabase.co`;
}
const sbView = s => ({ name: maskUrl(s.url), up: s.up, detail: s.detail, ms: s.ms, last: s.last, since: s.since });

// ---- helpers for the web server ----
const hits = new Map(); // ip -> [timestamps]
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= PER_IP_PER_HOUR) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list); return false;
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some(t => now - t < 3600e3)) hits.delete(ip); }, 3600e3).unref();

const clientIp = req => String(req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.socket.remoteAddress || "?";
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const view = s => ({ url: s.url, up: s.up, detail: s.detail, ms: s.ms, last: s.last, since: s.since });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 2000) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
const readJson = async req => { try { return JSON.parse(await readBody(req)) || {}; } catch (_) { return {}; } };

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pingerr: keep your render and supabase apps awake</title>
<style>
:root{--bg:#12151b;--panel:#191d25;--line:#2a303b;--text:#d3d9e2;--dim:#7f8a9b;--up:#4fd6a0;--down:#ff6b6b;--wait:#e0b24f;--acc:#7aa2ff;--sb:#3ecf8e;
--mono:ui-monospace,"JetBrains Mono","Cascadia Code","SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 var(--mono)}
main{max-width:860px;margin:0 auto;padding:28px 16px 60px}
a{color:inherit;text-decoration:none}a:hover{color:var(--acc)}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
h1{font-size:20px;margin:0 0 4px}h1 span{color:var(--acc)}
.sub{color:var(--dim);margin:0 0 22px}
.bar{display:flex;gap:18px;flex-wrap:wrap;border:1px solid var(--line);background:var(--panel);padding:10px 14px;margin-bottom:22px;color:var(--dim)}
.bar b{color:var(--text);font-weight:600}
form{display:flex;gap:8px;margin:0 0 6px}
form.col{flex-direction:column}
input{flex:1;min-width:0;background:var(--bg);border:1px solid var(--line);color:var(--text);padding:9px 11px;font:inherit}
input::placeholder{color:#566073}
button{background:var(--acc);color:#0c1020;border:0;padding:9px 16px;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
.sbsec button.go{background:var(--sb)}
button.ghost{background:transparent;color:var(--down);border:1px solid var(--line)}
.msg{min-height:22px;margin:0 0 26px;color:var(--dim)}.msg.err{color:var(--down)}.msg.ok{color:var(--up)}
h2{font-size:13px;font-weight:600;margin:0 0 8px;color:var(--dim)}h2 b{color:var(--text)}
.list{border:1px solid var(--line);background:var(--panel);margin-bottom:26px}
.row{display:grid;grid-template-columns:14px 1fr auto auto auto;gap:12px;align-items:center;padding:8px 14px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.dot{width:9px;height:9px;border-radius:50%;background:var(--wait)}.dot.up{background:var(--up)}.dot.down{background:var(--down)}
.url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dim{color:var(--dim);font-size:12px;white-space:nowrap}
.empty{padding:14px;color:var(--dim)}
.rules{color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
.rules p{margin:3px 0}
.sbsec{margin-top:36px;border-top:1px solid var(--line);padding-top:28px}
.sbsec h1 span{color:var(--sb)}
.lock{display:inline-block;border:1px solid var(--sb);color:var(--sb);font-size:11px;padding:1px 7px;margin-left:8px;vertical-align:middle}
.hint{color:var(--dim);font-size:12px;margin:0 0 4px}
details{margin:0 0 26px;border:1px solid var(--line);background:var(--panel);padding:10px 14px}
summary{cursor:pointer;color:var(--dim)}
details form{margin-top:12px}
.warn{border:1px solid var(--wait);background:#1d1a12;color:var(--text);padding:10px 14px;margin:0 0 14px}
.warn b{color:var(--wait)}
.steps{margin:0 0 12px;padding-left:20px;color:var(--dim)}
.steps li{margin:2px 0}.steps b{color:var(--text);font-weight:600}
.sqled{border:1px solid var(--line);background:var(--bg);margin:0 0 20px}
.sqled .top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);background:var(--panel);padding:6px 10px;color:var(--dim);font-size:12px}
.sqled button{padding:4px 12px;font-size:12px;background:var(--sb)}
.sqled pre{margin:0;padding:12px 14px;overflow-x:auto;font:13px/1.6 var(--mono);color:#cfe8ff;white-space:pre;user-select:all}
.sqled .k{color:#c792ea}.sqled .c{color:#5c6b80}
@media(max-width:640px){.row{grid-template-columns:14px 1fr auto}.row .ms,.row .ago{display:none}form{flex-direction:column}}
</style></head><body><main>
<h1><span>$</span> pingerr</h1>
<p class="sub">Pings your Render app every 14 minutes so it never goes to sleep. No login, no signup.</p>

<div class="bar">
  <div>next ping in <b id="next">--:--</b></div>
  <div>watching <b id="count">0</b></div>
  <div>up <b id="upn">0</b></div>
  <div>down <b id="downn">0</b></div>
</div>

<form id="f">
  <input id="u" type="url" placeholder="https://your-app.onrender.com" required autocomplete="off" spellcheck="false" aria-label="Your onrender.com URL">
  <button id="b" type="submit">add site</button>
</form>
<p id="msg" class="msg" role="status"></p>

<h2>pinging now (<b id="pn">0</b>)</h2>
<div class="list" id="pub"></div>

<div id="coreWrap" hidden>
  <h2>core targets (<b id="cn">0</b>)</h2>
  <div class="list" id="core"></div>
</div>

<div class="rules">
  <p>Only https://name.onrender.com addresses are accepted.</p>
  <p>Each site gets one GET request every 14 minutes. A status below 400 counts as up.</p>
  <p>Public sites are listed here for everyone. No emails are sent for them.</p>
  <p>A site that stays down for 7 days is removed automatically.</p>
</div>

<section class="sbsec">
  <h1><span>$</span> supabase keep-alive vault <span class="lock">encrypted</span></h1>
  <p class="sub">Free Supabase projects pause after 7 days without activity. Add yours and it gets one request a day so it stays awake.</p>

  <div class="bar">
    <div>next ping in <b id="sbnext">--:--</b></div>
    <div>projects <b id="sbcount">0</b></div>
    <div>up <b id="sbup">0</b></div>
    <div>down <b id="sbdown">0</b></div>
  </div>

  <div class="warn"><b>Important:</b> create the <b>keepalive</b> table below and type its name in the form. Without a table, Pingerr only touches the API gateway, which may not count as real database activity. With a table, every daily ping runs a real database query, so your project stays awake.</div>

  <h2>one-time setup in your Supabase project</h2>
  <ol class="steps">
    <li>Open <b>supabase.com/dashboard</b> and select your project.</li>
    <li>In the left sidebar click <b>SQL Editor</b>, then <b>New query</b>.</li>
    <li>Click <b>copy</b> on the box below and paste it into the editor (Ctrl+V).</li>
    <li>Click <b>Run</b> (or press Ctrl+Enter). You should see "Success. No rows returned".</li>
    <li>Come back here and type <b>keepalive</b> in the table name field, then add your project.</li>
  </ol>
  <div class="sqled">
    <div class="top"><span>sql editor / new query</span><button type="button" id="cp">copy</button></div>
<pre id="sqltext"><span class="c">-- Pingerr keep-alive table</span>
<span class="k">create table if not exists</span> keepalive (
  id <span class="k">int primary key</span>,
  pinged_at <span class="k">timestamptz default</span> now()
);

<span class="k">insert into</span> keepalive (id) <span class="k">values</span> (1)
<span class="k">on conflict do nothing</span>;

<span class="k">alter table</span> keepalive <span class="k">enable row level security</span>;

<span class="k">drop policy if exists</span> "anon can read keepalive" <span class="k">on</span> keepalive;
<span class="k">create policy</span> "anon can read keepalive"
  <span class="k">on</span> keepalive <span class="k">for select to</span> anon
  <span class="k">using</span> (true);</pre>
  </div>

  <form id="sf" class="col" autocomplete="off">
    <input id="su" type="url" placeholder="https://xxxxxxxxxxxxxxxxxxxx.supabase.co" required autocomplete="off" spellcheck="false" aria-label="Supabase project URL">
    <input id="sk" type="password" placeholder="anon / publishable key" required autocomplete="off" spellcheck="false" aria-label="Supabase anon key">
    <input id="st" type="text" placeholder="table name: keepalive (strongly recommended)" autocomplete="off" spellcheck="false" aria-label="Table name">
    <p class="hint">Type keepalive here after running the SQL above. This makes the daily ping a real database read.</p>
    <button id="sb" class="go" type="submit">add project</button>
  </form>
  <p id="smsg" class="msg" role="status"></p>

  <h2>keeping awake (<b id="sn">0</b>)</h2>
  <div class="list" id="sbl"></div>

  <details>
    <summary>remove my project</summary>
    <form id="rf" class="col" autocomplete="off">
      <input id="ru" type="url" placeholder="https://xxxxxxxxxxxxxxxxxxxx.supabase.co" required autocomplete="off" spellcheck="false" aria-label="Project URL to remove">
      <input id="rk" type="password" placeholder="the same anon key you added" required autocomplete="off" spellcheck="false" aria-label="Key used when adding">
      <button id="rb" class="ghost" type="submit">remove</button>
    </form>
    <p id="rmsg" class="msg" role="status"></p>
  </details>

  <div class="rules">
    <p>Only https://project-ref.supabase.co addresses are accepted.</p>
    <p>Use the anon / publishable key only. service_role and secret keys are rejected.</p>
    <p>Your key is encrypted with AES-256-GCM before it is saved. It is never shown again and never sent back to this page.</p>
    <p>Projects are listed with a masked name. One request per day.</p>
    <p>Pingerr cannot restore a project that is already paused. Restore it in the Supabase dashboard first.</p>
    <p>A project that stays unreachable for 7 days is removed automatically.</p>
  </div>
</section>
</main>
<script>
var $=function(s){return document.querySelector(s)};
var data=null,fetchedAt=0;
function ago(t){if(!t)return"-";var s=Math.round((Date.now()-new Date(t))/1000);return s<60?s+"s ago":s<3600?Math.round(s/60)+"m ago":Math.round(s/3600)+"h ago"}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function row(s){
  var r=el("div","row");
  r.appendChild(el("span","dot "+(s.last?(s.up?"up":"down"):"")));
  var a=el("a","url",s.url.slice(8));a.href=s.url;a.target="_blank";a.rel="noopener noreferrer";r.appendChild(a);
  r.appendChild(el("span","dim",s.detail));
  r.appendChild(el("span","dim ms",s.ms!=null?s.ms+" ms":"-"));
  r.appendChild(el("span","dim ago",ago(s.last)));
  return r;
}
function sbRow(s){
  var r=el("div","row");
  r.appendChild(el("span","dot "+(s.last?(s.up?"up":"down"):"")));
  r.appendChild(el("span","url",s.name));
  r.appendChild(el("span","dim",s.detail));
  r.appendChild(el("span","dim ms",s.ms!=null?s.ms+" ms":"-"));
  r.appendChild(el("span","dim ago",ago(s.last)));
  return r;
}
function fill(box,list,emptyText,rf){
  box.textContent="";
  if(!list.length){box.appendChild(el("div","empty",emptyText));return}
  list.forEach(function(s){box.appendChild((rf||row)(s))});
}
function render(){
  if(!data)return;
  fill($("#pub"),data.public,"No sites yet. Add yours above.");
  fill($("#core"),data.owner,"");
  $("#coreWrap").hidden=!data.owner.length;
  var all=data.owner.concat(data.public);
  $("#pn").textContent=data.public.length;$("#cn").textContent=data.owner.length;
  $("#count").textContent=all.length;
  $("#upn").textContent=all.filter(function(s){return s.last&&s.up}).length;
  $("#downn").textContent=all.filter(function(s){return s.last&&!s.up}).length;
  var sb=data.supabase||[];
  fill($("#sbl"),sb,"No projects yet. Add yours above.",sbRow);
  $("#sn").textContent=sb.length;$("#sbcount").textContent=sb.length;
  $("#sbup").textContent=sb.filter(function(s){return s.last&&s.up}).length;
  $("#sbdown").textContent=sb.filter(function(s){return s.last&&!s.up}).length;
}
function load(){
  return fetch("/api/status").then(function(r){return r.json()}).then(function(d){data=d;fetchedAt=Date.now();render()}).catch(function(){});
}
function clock(target){
  var ms=Math.max(0,target-data.now-(Date.now()-fetchedAt)),s=Math.round(ms/1000);
  if(s>=3600)return Math.floor(s/3600)+"h "+("0"+Math.floor((s%3600)/60)).slice(-2)+"m";
  return Math.floor(s/60)+":"+("0"+(s%60)).slice(-2);
}
function tick(){
  if(!data)return;
  $("#next").textContent=clock(data.nextAt);
  $("#sbnext").textContent=clock(data.sbNextAt);
}
$("#f").addEventListener("submit",function(e){
  e.preventDefault();
  var b=$("#b"),m=$("#msg");b.disabled=true;m.className="msg";m.textContent="adding...";
  fetch("/api/add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:$("#u").value})})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
    .then(function(x){m.className="msg "+(x.ok?"ok":"err");m.textContent=x.j.message||x.j.error;if(x.ok)$("#u").value="";return load()})
    .catch(function(){m.className="msg err";m.textContent="Network error. Try again."})
    .then(function(){b.disabled=false});
});
function vaultPost(path,body,btn,msg,onOk){
  btn.disabled=true;msg.className="msg";msg.textContent="working...";
  fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
    .then(function(x){msg.className="msg "+(x.ok?"ok":"err");msg.textContent=x.j.message||x.j.error;if(x.ok)onOk();return load()})
    .catch(function(){msg.className="msg err";msg.textContent="Network error. Try again."})
    .then(function(){btn.disabled=false});
}
$("#sf").addEventListener("submit",function(e){
  e.preventDefault();
  vaultPost("/api/supabase/add",{url:$("#su").value,key:$("#sk").value,table:$("#st").value},$("#sb"),$("#smsg"),function(){$("#su").value="";$("#sk").value="";$("#st").value=""});
});
$("#rf").addEventListener("submit",function(e){
  e.preventDefault();
  vaultPost("/api/supabase/remove",{url:$("#ru").value,key:$("#rk").value},$("#rb"),$("#rmsg"),function(){$("#ru").value="";$("#rk").value=""});
});
$("#cp").addEventListener("click",function(){
  var btn=$("#cp"),txt=$("#sqltext").innerText;
  function done(ok){btn.textContent=ok?"copied":"press Ctrl+C";setTimeout(function(){btn.textContent="copy"},1800)}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){done(true)},function(){sel()})}else{sel()}
  function sel(){var r=document.createRange();r.selectNodeContents($("#sqltext"));var s=getSelection();s.removeAllRanges();s.addRange(r);done(false)}
});
load();setInterval(load,30000);setInterval(tick,1000);setInterval(render,30000);
</script></body></html>`;

http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  try {
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      return res.end(PAGE);
    }
    if (req.method === "GET" && path === "/api/status") {
      const all = [...sites.values()];
      return json(res, 200, {
        now: Date.now(), nextAt, sbNextAt,
        owner: all.filter(s => s.owner).map(view),
        public: all.filter(s => !s.owner).map(view).reverse(),   // newest first
        supabase: [...sbs.values()].map(sbView).reverse(),
      });
    }
    if (req.method === "POST" && path === "/api/add") {
      let url;
      try { url = normalize(JSON.parse(await readBody(req)).url); } catch (_) { url = null; }
      if (!url) return json(res, 400, { error: "Only https://your-app.onrender.com addresses are accepted." });
      if (sites.has(url)) return json(res, 200, { message: "Already being pinged." });
      if (limited(clientIp(req))) return json(res, 429, { error: "Too many submissions. Try again in an hour." });
      if ([...sites.values()].filter(s => !s.owner).length >= MAX_PUBLIC) return json(res, 503, { error: "The list is full right now." });
      addSite(url, false); savePublic();
      check(sites.get(url));   // first ping right away, in the background
      return json(res, 200, { message: "Added. First ping is running now, then every 14 minutes." });
    }

    // ---- Supabase vault ----
    if (req.method === "POST" && path === "/api/supabase/add") {
      const b = await readJson(req);
      if (!VAULT_KEY) return json(res, 503, { error: "The vault is not set up on this server yet." });
      const url = sbNormalize(b.url);
      if (!url) return json(res, 400, { error: "Use your project URL: https://<project-ref>.supabase.co" });
      const key = String(b.key || "").trim();
      const kc = checkKey(key);
      if (!kc.ok) return json(res, 400, { error: kc.reason });
      const table = String(b.table || "").trim();
      if (table && !TABLE_RE.test(table)) return json(res, 400, { error: "Table names can only use letters, numbers and underscores." });
      if (sbs.has(url)) return json(res, 200, { message: "This project is already being pinged." });
      if (limited("sb:" + clientIp(req))) return json(res, 429, { error: "Too many submissions. Try again in an hour." });
      if ([...sbs.values()].filter(s => !s.owner).length >= MAX_SUPABASE) return json(res, 503, { error: "The list is full right now." });

      const r = await probe(url, table, key);   // test ping BEFORE anything is saved
      if (!r.ok) return json(res, 400, { error: `Test ping failed (${r.detail}). Check the URL, key and table, and make sure the project is not paused. Nothing was saved.` });

      const s = sbAdd(url, { enc: seal(key, url), table });
      s.last = new Date().toISOString(); s.detail = r.detail; s.ms = r.ms;
      saveSb();
      return json(res, 200, { message: "Added. The test ping worked. Your key is encrypted, and the project gets one request every 24 hours." });
    }
    if (req.method === "POST" && path === "/api/supabase/remove") {
      const b = await readJson(req);
      const url = sbNormalize(b.url), key = String(b.key || "").trim();
      if (limited("sbrm:" + clientIp(req))) return json(res, 429, { error: "Too many attempts. Try again in an hour." });
      const s = url && sbs.get(url);
      let match = false;
      if (s && !s.owner && VAULT_KEY && key) {
        try {
          const a = Buffer.from(unseal(s.enc, s.url)), c = Buffer.from(key);
          match = a.length === c.length && crypto.timingSafeEqual(a, c);
        } catch (_) { /* leave false */ }
      }
      if (!match) return json(res, 400, { error: "No project matches that URL and key." });
      sbs.delete(url); saveSb();
      return json(res, 200, { message: "Removed. Your key is deleted from this server." });
    }

    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
  } catch (e) {
    console.error("[http]", e.message);
    if (!res.headersSent) json(res, 500, { error: "Server error." });
  }
}).listen(process.env.PORT || 3000);

if (!sites.size) console.log("No URLS set in .env. Only public submissions will be pinged.");
if (!VAULT_KEY) console.log("ENCRYPTION_KEY not set: the Supabase vault will refuse new projects.");
console.log(`Pingerr watching ${sites.size} URL(s) every 14 min and ${sbs.size} Supabase project(s) every 24h.`);
round(); setInterval(round, EVERY);
sbRound(); setInterval(sbRound, SB_EVERY);
