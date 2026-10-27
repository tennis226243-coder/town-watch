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

// ---------- 1. ニュース収集 ----------
const TOWNS = ["会津若松", "喜多方", "会津坂下", "会津美里", "猪苗代", "南会津", "西会津", "磐梯町", "湯川村", "北塩原", "柳津町", "只見町", "下郷町"];
const MAIN_KW = ["オープン予定", "出店", "新店", "閉店", "出店計画", "オープニングスタッフ", "移転", "跡地"];
const EXTRA = ["会津若松 地鎮祭", "会津若松 起工式", "会津若松 開発許可", "会津若松 大規模小売店舗", "会津若松 進出", "会津 出店へ", "会津若松 着工", "会津若松 道路 開通", "会津若松 リニューアル"];
const QUERIES = [...MAIN_KW.map(k => `会津若松 ${k}`), ...TOWNS.slice(1, 6).flatMap(t => MAIN_KW.slice(0, 4).map(k => `${t} ${k}`)), ...TOWNS.slice(6).flatMap(t => ["オープン", "出店"].map(k => `${t} ${k}`)), ...EXTRA];
const LOCAL = /会津|若松|喜多方|鶴ヶ城|猪苗代|坂下|美里|磐梯|湯川|北塩原|柳津|只見|下郷|檜枝岐|三島町|金山町|昭和村/;
const tagOf = t => /閉店|撤退|閉鎖|営業終了/.test(t) ? "閉店" : /出店計画|進出|開発許可|大規模小売|地鎮祭|起工/.test(t) ? "計画" : /着工|建設|開発|工事|造成|分譲/.test(t) ? "建設" : /開通|道路|バイパス/.test(t) ? "道路" : /求人|スタッフ|募集/.test(t) ? "求人" : /オープン|出店|開店|新店|移転|リニューアル/.test(t) ? "出店" : "その他";
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
for (const it of targets) if (KEY) data.processed.push(keyOf(it));
data.processed = data.processed.slice(-3000);
data.log = data.log.slice(0, 100);
data.updatedAt = new Date().toISOString();
fs.writeFileSync("data.json", JSON.stringify(data));
console.log("projects:", data.projects.length, "processed:", targets.length, KEY ? "" : "(APIキー未設定のためニュース収集のみ)");
