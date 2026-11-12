// Pingerr: pings your URLs every 14 minutes and emails you the moment one fails.
// Anyone can also add their own *.onrender.com site (no login) and it gets pinged too.
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const { send } = require("./mail");

const EVERY = 14 * 60 * 1000;                 // fixed: 14 minutes
const TIMEOUT = 60 * 1000;                    // slow-waking hosts (free Render) can take ~50s
const MAX_PUBLIC = +process.env.MAX_PUBLIC || 200;           // cap on public sites
const PER_IP_PER_HOUR = +process.env.PER_IP_PER_HOUR || 5;   // submissions per IP per hour
const DROP_AFTER = 7 * 24 * 60 * 60 * 1000;   // public sites down this long are removed
const DATA_FILE = process.env.DATA_FILE || "public-sites.json";

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

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pingerr: keep your render apps awake</title>
<style>
:root{--bg:#12151b;--panel:#191d25;--line:#2a303b;--text:#d3d9e2;--dim:#7f8a9b;--up:#4fd6a0;--down:#ff6b6b;--wait:#e0b24f;--acc:#7aa2ff;
--mono:ui-monospace,"JetBrains Mono","Cascadia Code","SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 var(--mono)}
main{max-width:860px;margin:0 auto;padding:28px 16px 60px}
a{color:inherit;text-decoration:none}a:hover{color:var(--acc)}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
h1{font-size:20px;margin:0 0 4px}h1 span{color:var(--acc)}
.sub{color:var(--dim);margin:0 0 22px}
.bar{display:flex;gap:18px;flex-wrap:wrap;border:1px solid var(--line);background:var(--panel);padding:10px 14px;margin-bottom:22px;color:var(--dim)}
.bar b{color:var(--text);font-weight:600}
form{display:flex;gap:8px;margin:0 0 6px}
input{flex:1;min-width:0;background:var(--bg);border:1px solid var(--line);color:var(--text);padding:9px 11px;font:inherit}
input::placeholder{color:#566073}
button{background:var(--acc);color:#0c1020;border:0;padding:9px 16px;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
#msg{min-height:22px;margin:0 0 26px;color:var(--dim)}#msg.err{color:var(--down)}#msg.ok{color:var(--up)}
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
<p id="msg" role="status"></p>

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
function fill(box,list,emptyText){
  box.textContent="";
  if(!list.length){box.appendChild(el("div","empty",emptyText));return}
  list.forEach(function(s){box.appendChild(row(s))});
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
}
function load(){
  return fetch("/api/status").then(function(r){return r.json()}).then(function(d){data=d;fetchedAt=Date.now();render()}).catch(function(){});
}
function tick(){
  if(!data)return;
  var ms=Math.max(0,data.nextAt-data.now-(Date.now()-fetchedAt)),s=Math.round(ms/1000);
  $("#next").textContent=Math.floor(s/60)+":"+("0"+(s%60)).slice(-2);
}
$("#f").addEventListener("submit",function(e){
  e.preventDefault();
  var b=$("#b"),m=$("#msg");b.disabled=true;m.className="";m.textContent="adding...";
  fetch("/api/add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:$("#u").value})})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
    .then(function(x){m.className=x.ok?"ok":"err";m.textContent=x.j.message||x.j.error;if(x.ok)$("#u").value="";return load()})
    .catch(function(){m.className="err";m.textContent="Network error. Try again."})
    .then(function(){b.disabled=false});
});
load();setInterval(load,30000);setInterval(tick,1000);setInterval(render,30000);
</script></body></html>`;

http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  try {
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && path === "/api/status") {
      const all = [...sites.values()];
      return json(res, 200, {
        now: Date.now(), nextAt,
        owner: all.filter(s => s.owner).map(view),
        public: all.filter(s => !s.owner).map(view).reverse(),   // newest first
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
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
  } catch (e) {
    console.error("[http]", e.message);
    if (!res.headersSent) json(res, 500, { error: "Server error." });
  }
}).listen(process.env.PORT || 3000);

if (!sites.size) console.log("No URLS set in .env. Only public submissions will be pinged.");
console.log(`Pingerr watching ${sites.size} URL(s) every 14 min.`);
round(); setInterval(round, EVERY);
