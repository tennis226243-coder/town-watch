// 街の変化ウォッチ 自動更新スクリプト（GitHub Actions から実行）
// 1) 会津地方のニュースを Google ニュースと号外NETから集める → news.json
// 2) Claude API（ANTHROPIC_API_KEY がある場合）で記事を読み、出店・閉店などを案件として登録・更新 → data.json
import fs from "node:fs";

const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const MAX_PER_RUN = 25;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);

let data;
if (fs.existsSync("data.json")) data = JSON.parse(fs.readFileSync("data.json", "utf8"));
else {
  // 初回：index.html に埋め込まれたデータから data.json を作る
  const html = fs.readFileSync("index.html", "utf8");
  const start = html.indexOf("window.EMBED = ") + "window.EMBED = ".length;
  const end = html.indexOf(";</script>", start);
  const e = JSON.parse(html.slice(start, end));
  data = { projects: e.projects, configs: e.configs, processed: [], log: [] };
}
data.processed = data.processed || [];
data.log = data.log || [];
let news = { items: [] };
try { news = JSON.parse(fs.readFileSync("news.json", "utf8")); } catch {}

// ---------- 0a. index.html に新しく入った案件を data.json に取り込む ----------
try {
  const html = fs.readFileSync("index.html", "utf8");
  const st = html.indexOf("window.EMBED = ");
  if (st >= 0) {
    const e = JSON.parse(html.slice(st + "window.EMBED = ".length, html.indexOf(";</script>", st)));
    const ids = new Set(data.projects.map(p => p.id));
    const nn = s => (s || "").normalize("NFKC").replace(/（.*?）|\(.*?\)/g, "").replace(/[\s・\-「」『』]/g, "").replace(/^(イタリア食堂|スーパーセンター)/, "").replace(/(会津若松|会津|若松)?店?$/, "");
    for (const p of e.projects || []) if (!ids.has(p.id)) {
      // 同じ店を自動登録していた場合は、確認済みの案件に置き換える
      const k = nn(p.name);
      data.projects = data.projects.filter(x => !(x.auto && k && (nn(x.name).includes(k) || k.includes(nn(x.name)))));
      data.projects.push(p); data.log.unshift({ at: today, action: "追加", id: p.id, name: p.name, note: "確認済みの情報を追加" });
    }
    // サイト側の設定（エリア・予測など）が新しければ取り込む
    if (e.exportedAt && (!data.configsFrom || e.exportedAt > data.configsFrom)) { data.configs = e.configs; data.configsFrom = e.exportedAt; }
  }
} catch (err) { console.error("index.html", err.message); }

// ---------- 0. 手動で追加した案件（manual フォルダ）を反映 ----------
const DEFAULTS = { kind: "STORE", category: "other", size: "SMALL", status: "PLANNED", changeType: "NEW", confidence: "C", address: "", company: "", chain: "UNKNOWN", parking: "", plannedDate: "", openedDate: "", closedDate: "", areaId: "", areaManual: false, estimated: [], note: "", events: [], city: "aizuwakamatsu" };
if (fs.existsSync("manual")) {
  for (const f of fs.readdirSync("manual").filter(f => f.endsWith(".json"))) {
    let items; try { items = JSON.parse(fs.readFileSync("manual/" + f, "utf8")); } catch (e) { console.error("manual/" + f, e.message); continue; }
    for (const m of [].concat(items)) {
      if (!m || !m.id) continue;
      const cur = data.projects.find(p => p.id === m.id);
      if (cur) {
        const evIds = new Set((cur.events || []).map(e => e.id));
        const { events, ...rest } = m;
        Object.assign(cur, rest, { events: [...(cur.events || []), ...(events || []).filter(e => !evIds.has(e.id))], updatedAt: cur.updatedAt });
      } else {
        const p = { ...DEFAULTS, ...m, firstDiscoveredAt: m.firstDiscoveredAt || today, lastCheckedAt: today, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (typeof p.lat !== "number" && p.address) {
          try {
            const q = /福島県/.test(p.address) ? p.address : "福島県" + p.address;
            const res = await (await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(q))).json();
            if (res && res[0]) { p.lng = res[0].geometry.coordinates[0]; p.lat = res[0].geometry.coordinates[1]; p.latEst = true; }
          } catch {}
        }
        data.projects.push(p);
        data.log.unshift({ at: today, action: "手動登録", id: p.id, name: p.name, note: (p.note || "").slice(0, 60) });
      }
    }
  }
}

// ---------- 1. ニュース収集 ----------
const TOWNS = ["会津若松", "喜多方", "会津坂下", "会津美里", "猪苗代", "南会津", "西会津", "磐梯町", "湯川村", "北塩原", "柳津町", "只見町", "下郷町"];
const MAIN_KW = ["オープン予定", "出店", "新店", "閉店", "出店計画", "オープニングスタッフ", "移転", "跡地"];
const EXTRA = ["会津若松店 オープニング", "会津若松店 新店", "会津若松 グランドオープン", "会津 初出店", "会津若松 新規出店", "喜多方店 オープン", "会津若松 地鎮祭", "会津若松 起工式", "会津若松 開発許可", "会津若松 大規模小売店舗", "会津若松 進出", "会津 出店へ", "会津若松 着工", "会津若松 道路 開通", "会津若松 リニューアル"];
const QUERIES = [...MAIN_KW.map(k => `会津若松 ${k}`), ...TOWNS.slice(1, 6).flatMap(t => MAIN_KW.slice(0, 4).map(k => `${t} ${k}`)), ...TOWNS.slice(6).flatMap(t => ["オープン", "出店"].map(k => `${t} ${k}`)), ...EXTRA];
const LOCAL = /会津|若松|喜多方|鶴ヶ城|猪苗代|坂下|美里|磐梯|湯川|北塩原|柳津|只見|下郷|檜枝岐|三島町|金山町|昭和村/;
const tagOf = t => /閉店|撤退|閉鎖|営業終了/.test(t) ? "閉店" : /出店計画|初出店|進出|開発許可|大規模小売|地鎮祭|起工/.test(t) ? "計画" : /着工|建設|開発|工事|造成|分譲/.test(t) ? "建設" : /開通|道路|バイパス/.test(t) ? "道路" : /求人|スタッフ|募集/.test(t) ? "求人" : /オープン|出店|開店|新店|移転|リニューアル/.test(t) ? "出店" : "その他";
const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#8230;|&hellip;/g, "…").replace(/\s+/g, " ").trim();
const pick = (x, tag) => { const m = x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? dec(m[1]) : ""; };
const byTitle = new Map((news.items || []).map(i => [i.title, i]));
async function rss(url, source, query) {
  const xml = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 town-watch" } })).text();
  for (const it of xml.split("<item>").slice(1)) {
    let title = pick(it, "title"); const src = pick(it, "source") || source;
    if (src && title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
    if (!title || byTitle.has(title)) continue;
    const d = new Date(pick(it, "pubDate"));
    byTitle.set(title, { title, url: pick(it, "link"), source: src, date: isNaN(d) ? new Date().toISOString() : d.toISOString(), desc: pick(it, "description").slice(0, 300), tag: tagOf(title), local: LOCAL.test(title) || source.startsWith("号外NET"), query });
  }
}
for (const q of QUERIES) {
  try { await rss(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:30d")}&hl=ja&gl=JP&ceid=JP:ja`, "", q); } catch (e) { console.error(q, e.message); }
  await sleep(1200);
}
for (const u of ["https://aizu.goguynet.jp/category/cat_openclose/feed/", "https://aizu.goguynet.jp/feed/"]) {
  try { await rss(u, "号外NET 会津若松市・喜多方市", "号外NET"); } catch (e) { console.error(u, e.message); }
}
const cutoff = Date.now() - 90 * 864e5;
news = { updatedAt: new Date().toISOString(), items: [...byTitle.values()].filter(i => Date.parse(i.date) > cutoff).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 150) };
fs.writeFileSync("news.json", JSON.stringify(news, null, 1));
console.log("news:", news.items.length);

// ---------- 1b. ニュースの地名から位置を推定（地図に「未確認ニュース」として出す） ----------
const LANDMARK_GEO = { "会津若松駅": [37.5079, 139.9303], "駅前": [37.5070, 139.9310], "七日町": [37.4998, 139.9233], "神明通り": [37.4975, 139.9300], "鶴ヶ城": [37.4878, 139.9297], "千石通り": [37.5050, 139.9440], "西若松駅": [37.4860, 139.9141] };
const CITY_OF = t => ["喜多方", "会津坂下", "会津美里", "猪苗代", "南会津", "西会津", "磐梯", "湯川", "北塩原", "柳津", "只見", "下郷"].find(c => t.includes(c));
async function placeOf(it) {
  const t = (it.title + " " + (it.desc || "")).normalize("NFKC");
  for (const [k, v] of Object.entries(LANDMARK_GEO)) if (t.includes(k)) return { lat: v[0], lng: v[1], place: k };
  const towns = ((data.configs && data.configs.main && data.configs.main.areas) || []).flatMap(a => a.towns || []).filter(x => x && !/市$/.test(x) && !/^(会津坂下町|会津美里町)$/.test(x)).sort((a, b) => b.length - a.length);
  let town = towns.find(x => t.includes(x));
  if (!town) { const m = t.match(/([一-龠々]{1,5}(?:町|[0-9一二三四五六七八九]+丁目))/); if (m && !/^(会津|若松)/.test(m[1])) town = m[1]; }
  if (!town) return null;
  const city = CITY_OF(t);
  const q = "福島県" + (city ? "" : "会津若松市") + (city || "") + town;
  try {
    const res = await (await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(q))).json();
    if (res && res[0]) { const [lng, lat] = res[0].geometry.coordinates; return { lat, lng, place: town }; }
  } catch {}
  return null;
}
{
  let n = 0;
  for (const it of news.items) {
    if (n >= 40) break;
    if (it.geoTried || !it.local || !["出店", "計画", "建設", "閉店"].includes(it.tag)) continue;
    it.geoTried = true; n++;
    const g = await placeOf(it); if (g) it.geo = g;
    await sleep(200);
  }
  fs.writeFileSync("news.json", JSON.stringify(news, null, 1));
}

// ---------- 2. Claude で記事を読み、案件に反映 ----------
const keyOf = i => i.url || i.title;
const targets = news.items.filter(i => i.local && i.tag !== "その他" && !data.processed.includes(keyOf(i))).slice(0, MAX_PER_RUN);
const KINDS = { STORE: ["food", "retail", "drugstore", "supermarket", "homecenter", "beauty", "medical", "service", "hotel", "entertainment", "other"], LARGE_COMMERCIAL: ["supermarket", "homecenter", "drugstore", "shopping_center", "electronics", "specialty", "complex"], CONSTRUCTION: ["store", "commercial", "hotel", "apartment", "factory", "logistics", "public"], HOUSING: ["subdivision", "detached", "condo", "apartment"], EMPLOYMENT: ["opening_staff", "job", "large_job", "new_office"], INFRASTRUCTURE: ["road", "road_widening", "intersection", "new_road", "transit", "parking", "station", "large"] };
const ORDER = { PLANNED: 0, CONFIRMED: 1, OPEN: 2, CLOSED: 3 };
const okDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";

async function ask(items) {
  const projects = data.projects.filter(p => (p.city || "aizuwakamatsu") === "aizuwakamatsu");
  const known = projects.map(p => `${p.id}｜${p.name}｜${p.status}`).join("\n");
  const list = items.map((it, i) => `[${i}] ${it.date.slice(0, 10)}｜${it.source}｜${it.title}${it.desc ? "｜" + it.desc : ""}`).join("\n");
  const prompt = `あなたは福島県会津地方の「出店・閉店・開発」を記録する担当者です。下の記事一覧を読み、会津地方17市町村（会津若松市・喜多方市・会津坂下町・会津美里町・猪苗代町・南会津町など）の実在の店舗・施設・住宅開発・道路について、新規出店・出店計画・閉店・移転・改装・建設の情報だけを抽出してください。

厳守すること:
- イベントへの出店、催事、商品の話題、会津地方以外の店は action "skip"。
- 記事に書かれていない日付・住所・規模を推測で埋めない。不明は空文字。月までしかない日付はその月の末日。
- 既存案件と同じ店・施設なら action "update" とし、id に既存案件のidを入れる。
- confidence: 行政の届出・企業の公式発表は "B"、報道・地域ニュースは "C"、求人・噂・SNSは "D"。"A" は使わない。
- summary は記事をコピーせず、自分の言葉で40字以内。

既存案件（id｜名称｜状態）:
${known}

記事一覧:
${list}

次の形式のJSON配列だけを返してください（説明文やコードブロックは不要）。すべての記事について1件ずつ返すこと。
[{"i":記事番号,"action":"new|update|skip","id":"updateのときの既存id","name":"店名・施設名","kind":"STORE|LARGE_COMMERCIAL|CONSTRUCTION|HOUSING|EMPLOYMENT|INFRASTRUCTURE","category":"${Object.entries(KINDS).map(([k, v]) => k + ":" + v.join("/")).join("、")} のいずれか","size":"SMALL|MEDIUM|LARGE","status":"PLANNED|CONFIRMED|OPEN|CLOSED","changeType":"NEW|RELOCATION|RENEWAL|CLOSURE","address":"記事にある住所・地名（市町村名から）","plannedDate":"YYYY-MM-DD","openedDate":"YYYY-MM-DD","closedDate":"YYYY-MM-DD","confidence":"B|C|D","event":"JOB_POSTING|MEDIA_REPORT|OFFICIAL_ANNOUNCEMENT|ADMIN_DOCUMENT|CONSTRUCTION_START|OPENED|CLOSED|RELOCATED|RENEWED","summary":"40字以内"}]`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error("Claude API " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const text = (j.content || []).map(c => c.text || "").join("");
  const m = text.replace(/```json|```/g, "").match(/\[[\s\S]*\]/);
  return m ? JSON.parse(m[0]) : [];
}
async function geocode(address) {
  if (!address) return null;
  const q = /福島県/.test(address) ? address : "福島県" + address;
  try {
    const res = await (await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(q))).json();
    const top = res && res[0]; if (!top) return null;
    const [lng, lat] = top.geometry.coordinates; return { lat, lng };
  } catch { return null; }
}
const slug = s => "auto-" + [...s].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7).toString(36);

// ---------- 2b. 鍵なしの場合：ルール（パターン）で見出しから案件を作る ----------
const z2h = t => t.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, " ");
const NG = /イベント|フェス|マルシェ|祭|まつり|催事|フェア|展示|販売会|朝市|十日市|キッチンカー|出店者|募集します|コンテスト/;
const AIZU_PLACES = ["会津若松市", "喜多方市", "会津坂下町", "会津美里町", "猪苗代町", "南会津町", "西会津町", "磐梯町", "湯川村", "北塩原村", "柳津町", "只見町", "下郷町"];
function townsFromConfig() {
  const c = (data.configs && data.configs.main) || {};
  return (c.areas || []).flatMap(a => a.towns || []).filter(t => t && !/市|町$/.test(t) || /町$/.test(t)).sort((a, b) => b.length - a.length);
}
function ruleExtract(it) {
  let t = z2h(it.title).replace(/^【[^】]*】\s*/, "").trim();
  const text = t + " " + z2h(it.desc || "");
  if (NG.test(t)) return null;
  let name = (t.match(/[「『]([^」』]{2,30})[」』]/) || [])[1];
  if (!name) { const m = t.match(/^(.{2,25}?)(?:が|、|は)(?:.*?)(?:オープン|出店|開店|閉店|移転|開業|新設|進出|リニューアル)/); if (m) name = m[1]; }
  if (!name) return null;
  name = name.replace(/^(会津若松市?|会津|若松|喜多方市?)(に|で|の)?/, "").trim();
  if (name.length < 2 || NG.test(name) || /^(新店|新しい|話題の|人気の)/.test(name)) return null;
  const closed = /閉店|閉業|営業終了|撤退|閉鎖/.test(t);
  const moved = /移転/.test(t), renew = /リニューアル|改装/.test(t);
  const big = /大型|ショッピングセンター|モール|工業団地|ホテル/.test(t);
  // 日付
  const base = new Date(it.date);
  let y = null, mo = null, d = null;
  const ym = text.match(/(20\d{2}|\d{2})年\s*(\d{1,2})月(?:\s*(\d{1,2})日)?/);
  const md = text.match(/(\d{1,2})月\s*(\d{1,2})日/);
  const mOnly = text.match(/(\d{1,2})月(?:上旬|中旬|下旬|末|頃|ごろ|予定|オープン|開店|に)/);
  if (ym) { y = +ym[1] < 100 ? 2000 + +ym[1] : +ym[1]; mo = +ym[2]; d = ym[3] ? +ym[3] : null; }
  else if (md) { mo = +md[1]; d = +md[2]; }
  else if (mOnly) { mo = +mOnly[1]; }
  else if (/来年/.test(text)) { y = base.getFullYear() + 1; }
  let date = "";
  if (mo && mo >= 1 && mo <= 12) {
    if (!y) { y = base.getFullYear(); if (mo < base.getMonth() + 1 - 2) y += 1; }
    const last = new Date(y, mo, 0).getDate();
    date = `${y}-${String(mo).padStart(2, "0")}-${String(d && d <= last ? d : last).padStart(2, "0")}`;
  }
  const future = date ? date > today : /予定|計画|出店へ|進出へ|開業へ|初出店|方針|来年|来春|来秋|今冬|今秋|建設|着工/.test(t);
  const status = closed ? "CLOSED" : future ? (date ? "CONFIRMED" : "PLANNED") : "OPEN";
  // 場所
  const place = AIZU_PLACES.find(pl => text.includes(pl)) || AIZU_PLACES.find(pl => text.includes(pl.replace(/[市町村]$/, ""))) || "会津若松市";
  const town = townsFromConfig().find(tw => text.includes(tw)) || ((text.match(/([^\s、。]{1,6}(?:町|丁目))/) || [])[1] || "");
  return {
    name, status, changeType: closed ? "CLOSURE" : moved ? "RELOCATION" : renew ? "RENEWAL" : "NEW",
    kind: big ? "LARGE_COMMERCIAL" : "STORE", size: big ? "LARGE" : "SMALL",
    plannedDate: status !== "OPEN" && status !== "CLOSED" ? date : "", openedDate: status === "OPEN" ? (date && date <= today ? date : "") : "", closedDate: closed ? date : "",
    address: town && !town.startsWith(place) ? place + town : place, hasTown: !!town, dateEstimated: !!date && !d,
  };
}
const normName = s => (s || "").normalize("NFKC").replace(/[\s・\-（）()「」『』]/g, "").replace(/(会津若松|会津|若松)?店$/, "");
if (!KEY && targets.length) {
  for (const it of targets) {
    const r = ruleExtract(it); if (!r) continue;
    const isNews = /民友|民報|号外NET|NHK|テレビ|新聞|KFB|FCT|TUF|FTV/.test(it.source || "");
    const ev = { id: "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), type: r.status === "CLOSED" ? "CLOSED" : "MEDIA_REPORT", date: it.date.slice(0, 10), confidence: isNews ? "C" : "D", description: it.title.slice(0, 80), source: { name: it.source || "ニュース", url: it.url, title: it.title, tier: 2, publishedAt: it.date.slice(0, 10) } };
    const nn = normName(r.name);
    const cur = data.projects.find(p => { const pn = normName(p.name.replace(/（.*?）/g, "")); return pn && nn && (pn.includes(nn) || nn.includes(pn)); });
    if (cur) {
      if ((cur.events || []).some(e => e.source && e.source.url === it.url)) continue;
      cur.events = [...(cur.events || []), ev];
      if (ORDER[r.status] > (ORDER[cur.status] ?? -1)) cur.status = r.status;
      for (const k of ["plannedDate", "openedDate", "closedDate"]) if (r[k] && !cur[k]) cur[k] = r[k];
      cur.lastCheckedAt = today; cur.updatedAt = new Date().toISOString();
      data.log.unshift({ at: today, action: "更新", id: cur.id, name: cur.name, note: it.title.slice(0, 60) });
    } else {
      const g2 = news.items.find(n => n.url === it.url && n.geo);
      const geo = g2 ? g2.geo : r.hasTown ? await geocode(r.address) : null;
      const id = slug(r.name);
      if (data.projects.some(x => x.id === id)) continue;
      data.projects.push({
        id, name: r.name.slice(0, 40), kind: r.kind, category: r.kind === "STORE" ? "other" : "specialty", size: r.size, status: r.status, changeType: r.changeType,
        confidence: ev.confidence, address: r.address, company: "", chain: "UNKNOWN", parking: "",
        plannedDate: r.plannedDate, openedDate: r.openedDate, closedDate: r.closedDate,
        firstDiscoveredAt: ev.date, lastCheckedAt: today, areaId: "", areaManual: false,
        estimated: ["address", "size", ...(r.dateEstimated ? ["plannedDate"] : [])],
        note: "自動登録（見出しから機械的に抽出。未確認）", events: [ev], auto: true, city: "aizuwakamatsu",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...(geo ? { lat: geo.lat, lng: geo.lng, latEst: true } : {}),
      });
      data.log.unshift({ at: today, action: "新規", id, name: r.name, note: it.title.slice(0, 60) });
      await sleep(300);
    }
  }
}

if (KEY && targets.length) {
  let results = [];
  try { results = await ask(targets); } catch (e) { console.error(e.message); }
  for (const r of results) {
    const it = targets[r.i]; if (!it || !r || r.action === "skip") continue;
    const ev = { id: "e" + Date.now().toString(36) + r.i, type: r.event || "MEDIA_REPORT", date: it.date.slice(0, 10), confidence: ["B", "C", "D"].includes(r.confidence) ? r.confidence : "C", description: String(r.summary || "").slice(0, 80), source: { name: it.source || "ニュース", url: it.url, title: it.title, tier: r.confidence === "D" ? 3 : 2, publishedAt: it.date.slice(0, 10) } };
    if (r.action === "update") {
      const p = data.projects.find(x => x.id === r.id); if (!p) continue;
      if ((p.events || []).some(e => e.source && e.source.url === it.url)) continue;
      p.events = [...(p.events || []), ev];
      if (r.status && ORDER[r.status] > (ORDER[p.status] ?? -1)) p.status = r.status;
      for (const k of ["plannedDate", "openedDate", "closedDate"]) if (okDate(r[k]) && !p[k]) p[k] = okDate(r[k]);
      if (r.status === "OPEN" && !p.openedDate && ev.type === "OPENED") p.openedDate = ev.date;
      p.lastCheckedAt = today; p.updatedAt = new Date().toISOString();
      data.log.unshift({ at: today, action: "更新", id: p.id, name: p.name, note: ev.description });
    } else if (r.action === "new" && r.name) {
      const id = slug(r.name);
      if (data.projects.some(x => x.id === id || x.name === r.name)) continue;
      const kind = KINDS[r.kind] ? r.kind : "STORE";
      const geo = await geocode(r.address);
      const p = {
        id, name: String(r.name).slice(0, 60), kind, category: KINDS[kind].includes(r.category) ? r.category : KINDS[kind][0],
        size: ["SMALL", "MEDIUM", "LARGE"].includes(r.size) ? r.size : "SMALL",
        status: ORDER[r.status] !== undefined ? r.status : "PLANNED", changeType: ["NEW", "RELOCATION", "RENEWAL", "CLOSURE"].includes(r.changeType) ? r.changeType : "NEW",
        confidence: ev.confidence, address: String(r.address || ""), company: "", chain: "UNKNOWN", parking: "",
        plannedDate: okDate(r.plannedDate), openedDate: okDate(r.openedDate), closedDate: okDate(r.closedDate),
        firstDiscoveredAt: ev.date, lastCheckedAt: today, areaId: "", areaManual: false, estimated: ["address", "size"],
        note: "自動登録（AIが記事から抽出。未確認）", events: [ev], auto: true, city: "aizuwakamatsu",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...(geo ? { lat: geo.lat, lng: geo.lng, latEst: true } : {}),
      };
      data.projects.push(p);
      data.log.unshift({ at: today, action: "新規", id, name: p.name, note: ev.description });
      await sleep(300);
    }
  }
}
for (const it of targets) data.processed.push(keyOf(it));
data.processed = data.processed.slice(-3000);
data.log = data.log.slice(0, 100);
data.updatedAt = new Date().toISOString();
fs.writeFileSync("data.json", JSON.stringify(data));
console.log("projects:", data.projects.length, "processed:", targets.length, KEY ? "(AIで抽出)" : "(ルールで抽出)");
