const { createHash } = require("crypto");

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 13_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Mobile/15E148 Safari/604.1";
const KUGOU_API = "https://gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt";
const SECRET = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
const PAGE = 300;

// ===== DeepSeek AI（生成推荐祝词）=====
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_KEY = "sk-9bf9272144d042d18df3396d09ec744d";
const DEEPSEEK_MODEL = "deepseek-v4-pro";

function md5(str) {
  return createHash("md5").update(str, "utf8").digest("hex");
}

async function signParams(params) {
  const n = Date.now();
  const base = {
    srcappid: "2919", clientver: "20000", clienttime: String(n),
    mid: String(n), uuid: String(n), dfid: "-"
  };
  Object.assign(base, params);
  const keys = Object.keys(base).sort();
  const s = SECRET + keys.map(k => k + "=" + base[k]).join("") + SECRET;
  base.signature = md5(s);
  return base;
}

function buildQuery(obj) {
  return Object.keys(obj).map(k =>
    encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])
  ).join("&");
}

function gcidFromUrl(url) {
  const m = url.match(/gcid_(\w+)/);
  return m ? m[1] : "";
}

async function fetchPageMeta(gcid) {
  const pageUrl = "https://m.kugou.com/songlist/gcid_" + gcid + "/";
  const r = await fetch(pageUrl, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("分享页请求失败 HTTP " + r.status);
  const html = await r.text();
  const kwIdx = html.indexOf("window.$output");
  let m = null;
  if (kwIdx >= 0) {
    let i = html.indexOf("{", kwIdx);
    if (i >= 0) {
      let depth = 0, inStr = false, esc = false, start = i;
      for (; i < html.length; i++) {
        const c = html[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) { m = html.slice(start, i + 1); break; }
        }
      }
    }
  }
  if (!m) throw new Error("无法从分享页解析数据（可能被风控或页面结构变化）");
  const d = JSON.parse(m);
  const li = d.info.listinfo;
  return {
    gcid,
    name: li.name || "",
    specialid: li.specialid || 0,
    is_def: li.is_def || 0,
    userid: li.list_create_userid || 0,
    count: li.count || 0,
    preview: d.info.songs || []
  };
}

async function fetchSpecial(specialid, gc, begin) {
  const p = await signParams({ specialid: String(specialid), gc, begin_idx: String(begin), pagesize: String(PAGE) });
  const url = KUGOU_API + "?" + buildQuery(p);
  const r = await fetch(url, { headers: { "User-Agent": UA, "Referer": "https://m.kugou.com/" } });
  if (!r.ok) throw new Error("API HTTP " + r.status);
  const d = await r.json();
  const data = d.data || {};
  return { count: data.count || 0, songs: data.songs || data.info || [] };
}

async function fetchGid(gid, begin) {
  const p = await signParams({
    area_code: "1", begin_idx: String(begin), plat: "1", type: "1", mode: "1",
    personal_switch: "1", extend_fields: "abtags,hot_cmt,popularization",
    pagesize: String(PAGE), global_collection_id: gid
  });
  const url = KUGOU_API + "?" + buildQuery(p);
  const r = await fetch(url, { headers: { "User-Agent": UA, "Referer": "https://m.kugou.com/" } });
  if (!r.ok) throw new Error("API HTTP " + r.status);
  const d = await r.json();
  const data = d.data || {};
  return { count: data.count || 0, songs: data.songs || data.info || [] };
}

async function findGidByPreview(userid, preview) {
  const prevNames = new Set(preview.filter(s => s && s.name).map(s => s.name));
  let best = null;
  for (let n = 1; n <= 60; n++) {
    const gid = "collection_3_" + userid + "_" + n + "_0";
    const { count, songs } = await fetchGid(gid, 0);
    if (!songs.length) continue;
    const names = new Set(songs.filter(s => s && s.name).map(s => s.name));
    let match = 0;
    prevNames.forEach(x => { if (names.has(x)) match++; });
    if (best === null || match > best.match) best = { match, gid, count };
    if (match >= prevNames.size) break;
    await sleep(300);
  }
  return best;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAll(fetcher) {
  const all = []; const seen = new Set();
  let begin = 0;
  while (true) {
    const { count, songs } = await fetcher(begin);
    for (const s of songs) {
      if (!s) continue;
      const key = s.hash || s.audio_id || s.name || "";
      if (key && !seen.has(key)) { seen.add(key); all.push(s); }
    }
    if (songs.length < PAGE || (count && all.length >= count) || !songs.length) break;
    begin += PAGE;
    await sleep(300);
  }
  return all;
}

function parseSong(s) {
  const si = s.singerinfo || [];
  let singer = si.filter(x => x && x.name).map(x => x.name).join("、");
  const name = s.name || "";
  let songname = "";
  if (name) {
    const idx = name.indexOf(" - ");
    if (idx >= 0) {
      if (!singer) singer = name.substring(0, idx);
      songname = name.substring(idx + 3);
    } else {
      songname = name;
    }
  } else {
    songname = s.remark || "";
  }
  return [songname.trim(), singer.trim()];
}

// ===== QQ 音乐歌单 =====

function extractQQPlaylistId(text) {
  if (!text) return "";
  const m = text.match(/https?:\/\/[\w.-]*y\.qq\.com\/[^\s]*[?&]id=(\d+)/);
  if (m) return m[1];
  // 纯数字歌单 id
  const t = text.trim();
  if (/^\d{5,}$/.test(t)) return t;
  return "";
}

function stripJsonp(text) {
  const m = text.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  return m ? m[1] : text;
}

async function fetchQQPlaylist(id) {
  const url = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg" +
    "?disstid=" + id + "&type=1&json=1&utf8=1&onlysong=0&format=json";
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Referer": "https://y.qq.com/n/ryqq/playlist/" + id }
  });
  if (!r.ok) throw new Error("API HTTP " + r.status);
  let j;
  try {
    j = JSON.parse(stripJsonp((await r.text()).trim()));
  } catch (e) {
    throw new Error("解析响应失败");
  }
  const cd = (j.cdlist && j.cdlist[0]) || {};
  const songs = cd.songlist || [];
  if (!songs.length) return fetchQQPlaylistAlt(id);
  return { id, name: cd.dissname || cd.diss_name || cd.title || "", songs };
}

async function fetchQQPlaylistAlt(id) {
  const body = {
    comm: { cv: 4747474, ct: 24, format: "json", inCharset: "utf-8", outCharset: "utf-8", notice: 0, platform: "yqq.json", needNewCode: 1, uin: "0" },
    playlist: { method: "GetPlaylistDetail", module: "music.playlist.PlaylistDetailServer", param: { id: Number(id), n: 1000, order: 5 } }
  };
  const r = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: { "User-Agent": UA, "Referer": "https://y.qq.com/n/ryqq/playlist/" + id, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("API HTTP " + r.status);
  const j = await r.json();
  const pl = j.playlist || {};
  const data = pl.data || {};
  const songs = data.songlist || data.songs || pl.songlist || [];
  const name = data.title || data.name || pl.title || pl.name || "";
  if (!songs.length) throw new Error("未获取到歌曲列表");
  return { id, name, songs };
}

function parseQQSong(s) {
  const name = s.songname || s.name || "";
  const singer = (s.singer || []).filter(x => x && x.name).map(x => x.name).join("、");
  return [name.trim(), singer.trim()];
}

// ===== 推荐抽取 + AI 祝词 =====

function pickRandomIndexes(total, count) {
  const n = Math.max(0, Math.min(count, total));
  const idx = Array.from({ length: total }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n);
}

async function generateBlessing(songName, singer, tags, wordLimit, custom) {
  const tagText = (tags && tags.length) ? tags.join("、") : "大家";
  const wl = parseInt(wordLimit, 10) || 50;
  const extra = (custom && custom.trim()) ? "；5. 额外要求：" + custom.trim() : "";
  const system = "你是文笔优美的祝福语写手。请根据歌曲《" + songName + "》（歌手：" + singer + "）的主题意境，写一段祝福语，要求：" +
    "1. 先从歌名或歌曲主题中提炼一个意象或关键词切入，再自然展开；" +
    "2. 多用对仗、排比等修辞，语言有画面感、有诗意，节奏舒缓从容；" +
    "3. 结尾落到对「" + tagText + "」的祝愿，真诚温暖；" +
    "4. 全文约 " + wl + " 字" + extra +
    "。直接输出祝福语正文，不要引号、不要标题、不要解释、不要出现「祝词」字样。";
  const r = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + DEEPSEEK_KEY
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: "歌曲《" + songName + "》 歌手：" + singer }
      ],
      temperature: 0.9,
      max_tokens: Math.max(80, wl * 3),
      thinking: { type: "disabled" }
    })
  });
  if (!r.ok) throw new Error("AI HTTP " + r.status);
  const j = await r.json();
  const c = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  return c.trim();
}

// ===== 智能排序（推荐多种播放顺序方案）=====

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

async function sortSongsByAI(songs, planCount) {
  if (!songs || songs.length < 2) {
    return [{ name: "原顺序", desc: "歌曲较少，按原顺序播放", order: songs.map((_, i) => i) }];
  }
  const n = Math.max(3, parseInt(planCount, 10) || 5);
  const listText = songs.map((s, i) => (i + 1) + ". 《" + s.name + "》 " + s.singer).join("\n");
  const system = "你是资深音乐歌单策划与情绪编曲师。请先逐一分析每首歌的主题意境与情感基调（如欢快、忧伤、温暖、激昂、治愈、思念、释怀等），再基于「多种情感的融合与起承转合」为下面的歌曲设计 " + n + " 种不同的播放顺序方案。要求：1. " + n + " 种方案之间要有明显差异，例如「情感递进式（从平静到高潮）」「情感起伏式（悲喜交织）」「情感疗愈式（先抑后扬）」「快慢交替式」「故事叙事式」等；2. 每个方案要说明它如何把多种情感串联成一个完整的情绪曲线；3. 每种方案给出一个名字和一句话说明；4. 只输出 JSON，格式为 {\"plans\":[{\"name\":\"方案名\",\"desc\":\"一句话说明\",\"order\":[原始序号...]}]}，其中 order 是歌曲原始序号（从 1 开始）按新播放顺序排列的完整数组，必须包含全部歌曲且不重复。不要输出任何 JSON 以外的文字或解释。";
  const r = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + DEEPSEEK_KEY
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: "歌曲列表：\n" + listText }
      ],
      temperature: 0.7,
      max_tokens: 1500,
      thinking: { type: "disabled" }
    })
  });
  if (!r.ok) throw new Error("AI HTTP " + r.status);
  const j = await r.json();
  const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  const data = extractJson(content);
  if (!data || !Array.isArray(data.plans) || !data.plans.length) throw new Error("未能解析排序方案");
  const plans = [];
  for (const p of data.plans) {
    const order = (p.order || []).map(n => parseInt(n, 10) - 1);
    const inRange = order.every(i => Number.isInteger(i) && i >= 0 && i < songs.length);
    const complete = order.length === songs.length && (new Set(order).size === order.length);
    if (inRange && complete) {
      plans.push({ name: p.name || "排序方案", desc: p.desc || "", order });
    }
  }
  if (!plans.length) throw new Error("未能生成有效的排序方案");
  return plans;
}

function formatSongsList(title, list, label) {
  const head = "歌单：《" + title + "》  " + (label || ("筛选出 " + list.length + " 首"));
  const lines = [head, "=".repeat(40)];
  list.forEach((s, i) => {
    lines.push(String(i + 1).padStart(3, " ") + ". " + s.name + " —— " + s.singer);
  });
  lines.push("=".repeat(40));
  lines.push("合计 " + list.length + " 首");
  return lines.join("\n");
}

async function filterSongsByAI(songsList, condition) {
  const listText = songsList.map((s, i) => (i + 1) + ". 《" + s.name + "》 " + s.singer).join("\n");
  const system = "你是歌单选曲助手。请根据用户给出的筛选条件，从下面的歌曲列表中选出所有符合条件的歌曲。只输出 JSON，格式为 {\"indexes\":[序号数组]}，序号为歌曲列表中的编号（从 1 开始）。若没有符合条件的歌曲，输出 {\"indexes\":[]}。不要输出任何 JSON 以外的文字或解释。";
  const r = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + DEEPSEEK_KEY
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: "筛选条件：" + condition + "\n\n歌曲列表：\n" + listText }
      ],
      temperature: 0.3,
      max_tokens: 1000,
      thinking: { type: "disabled" }
    })
  });
  if (!r.ok) throw new Error("AI HTTP " + r.status);
  const j = await r.json();
  const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  const data = extractJson(content);
  if (!data || !Array.isArray(data.indexes)) throw new Error("未能解析筛选结果");
  const idxs = data.indexes.map(n => parseInt(n, 10) - 1).filter(i => i >= 0 && i < songsList.length);
  return idxs.map(i => songsList[i]);
}

async function recommendFromList(title, songsList, count, tags, wordLimit, custom, wantBlessing) {
  count = parseInt(count, 10) || 0;
  const customText = (custom && custom.trim()) ? custom.trim() : "";

  // 不要祝词模式
  if (wantBlessing === false) {
    // 有文本条件 → 用 AI 筛选歌单
    if (customText) {
      const filtered = await filterSongsByAI(songsList, customText);
      const out = formatSongsList(title, filtered, "按条件筛选出 " + filtered.length + " 首");
      return { out, n: filtered.length, picks: [], songs: filtered };
    }
    // 无文本条件 → 随机推荐或完整列表（均不带祝词）
    const n = count > 0 ? Math.min(count, songsList.length) : 0;
    if (n <= 0) {
      const out = formatSongsList(title, songsList, "共 " + songsList.length + " 首");
      return { out, n: 0, picks: [], songs: songsList };
    }
    const idxs = pickRandomIndexes(songsList.length, n);
    const picked = idxs.map(i => songsList[i]);
    const out = formatSongsList(title, picked, "随机推荐 " + picked.length + " 首");
    return { out, n, picks: [], songs: picked };
  }

  // 要祝词模式（原逻辑）
  const n = count > 0 ? Math.min(count, songsList.length) : 0;
  if (n <= 0) {
    const out = formatSongsList(title, songsList, "共 " + songsList.length + " 首");
    return { out, n: 0, picks: [], songs: songsList };
  }
  // 推荐模式：只返回抽中的歌 + 祝词
  const idxs = pickRandomIndexes(songsList.length, n);
  const lines = ["歌单：《" + title + "》  随机推荐 " + n + " 首", "=".repeat(40)];
  const picks = [];
  for (let k = 0; k < idxs.length; k++) {
    const s = songsList[idxs[k]];
    lines.push(String(k + 1).padStart(3, " ") + ". " + s.name + " —— " + s.singer);
    let blessing;
    try {
      blessing = await generateBlessing(s.name, s.singer, tags, wordLimit, customText);
    } catch (e) {
      blessing = "（生成失败：" + e.message + "）";
    }
    lines.push("     🎁 祝词：" + blessing);
    picks.push({ name: s.name, singer: s.singer, blessing });
  }
  lines.push("=".repeat(40));
  return { out: lines.join("\n"), n, picks, songs: songsList };
}

// ===== 网易云音乐歌单 =====

function extractNeteasePlaylistId(text) {
  if (!text) return "";
  const m = text.match(/https?:\/\/music\.163\.com\/[^\s]*[?&]id=(\d+)/);
  if (m) return m[1];
  return "";
}

async function fetchNeteasePlaylist(id) {
  const url = "https://music.163.com/api/v6/playlist/detail?id=" + id + "&n=1000&s=0";
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://music.163.com/"
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error("API HTTP " + r.status);
      const j = await r.json();
      const pl = j.playlist || {};
      const songs = pl.tracks || [];
      if (songs.length) return { id, name: pl.name || "", songs };
      lastErr = new Error("未获取到歌曲列表");
    } catch (e) {
      lastErr = e;
    }
    await sleep(600);
  }
  throw lastErr || new Error("未获取到歌曲列表");
}

function parseNeteaseSong(s) {
  const name = s.name || "";
  const singer = (s.ar || []).filter(x => x && x.name).map(x => x.name).join("、");
  return [name.trim(), singer.trim()];
}

function extractUrl(text) {
  if (!text) return "";
  let m = text.match(/https?:\/\/m\.kugou\.com\/songlist\/gcid_\w+\/?[^\s）)]*/);
  if (!m) m = text.match(/https?:\/\/[\w.]*kugou\.com\/songlist\/gcid_\w+\/?[^\s）)]*/);
  return m ? m[0] : "";
}

function toSongList(songs, parseFn) {
  return songs.map(s => {
    const [name, singer] = parseFn(s);
    return { name, singer };
  });
}

function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  // 纯数字 → QQ 歌单 id
  if (/^\d{5,}$/.test(t)) return { type: "qq", id: t, count: null };
  const m = t.match(/https?:\/\/[^\s]+/);
  if (!m) return null;
  const url = m[0];
  const rest = t.slice(m.index + m[0].length).trim();
  let count = null;
  const cm = rest.match(/(\d+)/);
  if (cm) count = parseInt(cm[1], 10);

  const neId = extractNeteasePlaylistId(url);
  if (neId) return { type: "netease", id: neId, count };
  const qqId = extractQQPlaylistId(url);
  if (qqId) return { type: "qq", id: qqId, count };
  const ku = extractUrl(url);
  if (ku) return { type: "kugou", gcid: gcidFromUrl(ku), count };
  return null;
}

async function fetchSongsListByEntry(e) {
  if (e.type === "netease") {
    const meta = await fetchNeteasePlaylist(e.id);
    return { title: meta.name, list: toSongList(meta.songs, parseNeteaseSong) };
  }
  if (e.type === "qq") {
    const meta = await fetchQQPlaylist(e.id);
    return { title: meta.name, list: toSongList(meta.songs, parseQQSong) };
  }
  // 酷狗
  const meta = await fetchPageMeta(e.gcid);
  let songs;
  if (meta.specialid) {
    songs = await fetchAll(b => fetchSpecial(meta.specialid, e.gcid, b));
  } else {
    const best = await findGidByPreview(meta.userid, meta.preview);
    if (!best || best.match < 3) throw new Error("未能匹配到该歌单的 ID");
    songs = await fetchAll(b => fetchGid(best.gid, b));
  }
  songs.sort((a, b) => ((a.sort != null ? a.sort : 0) - (b.sort != null ? b.sort : 0)));
  return { title: meta.name, list: toSongList(songs, parseSong) };
}

async function handleRun(text, count, tags, wordLimit, custom, limit, wantBlessing, manualSongs) {
  const manual = (Array.isArray(manualSongs) ? manualSongs : []).map(s => ({
    name: (s && s.name ? String(s.name) : "").trim(),
    singer: (s && s.singer ? String(s.singer) : "").trim()
  })).filter(s => s.name);

  if ((!text || !text.trim()) && !manual.length) return { status: "请粘贴歌单分享链接或手动添加歌名。", out: "", picks: [], songs: [] };

  // 支持多行、每行一个链接，链接后可跟数量
  const entries = [];
  if (text && text.trim()) {
    for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      const p = parseLine(line);
      if (p) entries.push(p);
    }
  }

  const defaultLimit = parseInt(limit, 10) || 0;
  const merged = [];
  const seen = new Set();
  const logLines = [];
  let firstTitle = "";

  for (const e of entries) {
    try {
      const { title, list } = await fetchSongsListByEntry(e);
      const per = (e.count != null) ? e.count : defaultLimit;
      const slice = (per > 0 && list.length > per) ? list.slice(0, per) : list;
      let added = 0;
      for (const s of slice) {
        if (!seen.has(s.name)) { seen.add(s.name); merged.push(s); added++; }
      }
      if (!firstTitle) firstTitle = title;
      logLines.push("《" + title + "》提取 " + slice.length + " 首，去重后新增 " + added + " 首");
    } catch (err) {
      logLines.push("抓取失败：" + err.message);
    }
  }

  // 手动添加的歌名（按歌名去重，与歌单重复的过滤掉）
  if (manual.length) {
    let added = 0;
    for (const s of manual) {
      if (!seen.has(s.name)) { seen.add(s.name); merged.push(s); added++; }
    }
    logLines.push("手动添加 " + manual.length + " 首，去重后新增 " + added + " 首");
  }

  if (!merged.length) return { status: logLines.join("\n") + "\n未能合并到任何歌曲。", out: "", picks: [], songs: [] };

  const title = entries.length > 1 ? "合并歌单" : (firstTitle || "手动歌单");
  const result = await recommendFromList(title, merged, count, tags, wordLimit, custom, wantBlessing);
  const status = "合计 " + merged.length + " 首（已按歌名去重）\n" + logLines.join("\n") + runTip(result.n, wantBlessing);
  return { status: status + "\n\n" + result.out, out: result.out, picks: result.picks, songs: result.songs };
}

function runTip(n, wantBlessing) {
  if (!n) return "";
  return wantBlessing === false ? "  随机推荐 " + n + " 首" : "  随机推荐 " + n + " 首（附祝词）";
}

function jsonResponse(obj) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj)
  };
}

exports.main_handler = async (event, context) => {
  const path = event.path || "/";
  const method = (event.httpMethod || "GET").toUpperCase();

  if (path === "/run" && method === "POST") {
    try {
      const body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {});
      const result = await handleRun(body.text || "", body.count, body.tags || [], body.wordLimit, body.custom || "", body.limit, body.wantBlessing, body.manualSongs);
      return jsonResponse(result);
    } catch (e) {
      return jsonResponse({ status: "服务异常：" + e.message, out: "", picks: [], songs: [] });
    }
  }
  if (path === "/rebless" && method === "POST") {
    try {
      const body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {});
      const blessing = await generateBlessing(body.songName || "", body.singer || "", body.tags || [], body.wordLimit, body.custom || "");
      return jsonResponse({ blessing });
    } catch (e) {
      return jsonResponse({ blessing: "", error: e.message });
    }
  }
  if (path === "/sort" && method === "POST") {
    try {
      const body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {});
      const songs = Array.isArray(body.songs) ? body.songs.map(s => ({ name: s.name || "", singer: s.singer || "" })) : [];
      if (!songs.length) return jsonResponse({ plans: [], error: "未提供歌曲列表" });
      const plans = await sortSongsByAI(songs, body.planCount);
      return jsonResponse({ plans });
    } catch (e) {
      return jsonResponse({ plans: [], error: e.message });
    }
  }
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: HTML };
};

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>歌单提取（酷狗 / QQ音乐 / 网易云）</title>
<style>
  :root { --bg:#f5f6fa; --card:#fff; --pri:#2b6cff; --pri-h:#1d54d8; --text:#1a1a1a; --mut:#666; --bd:#e2e5ee; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; font-size:15px; line-height:1.6; }
  .wrap { max-width:720px; margin:0 auto; padding:14px 14px 80px; }
  header { text-align:center; padding:10px 0 16px; }
  header h1 { margin:0 0 4px; font-size:20px; }
  header p { margin:0; color:var(--mut); font-size:12px; }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:10px; padding:14px; margin:12px 0; box-shadow:0 1px 3px rgba(0,0,0,.04); }
  textarea { width:100%; border:1px solid var(--bd); border-radius:8px; padding:10px; font:inherit; resize:vertical; min-height:90px; background:#fff; }
  textarea:focus { outline:2px solid var(--pri); border-color:var(--pri); }
  button { display:block; width:100%; background:var(--pri); color:#fff; border:none; border-radius:8px; padding:12px; font:inherit; font-size:16px; font-weight:600; margin-top:10px; cursor:pointer; }
  button:hover:not(:disabled) { background:var(--pri-h); }
  button:disabled { background:#a8b3d4; cursor:not-allowed; }
  .lbl { font-size:13px; color:var(--mut); margin:0 0 6px; }
  .log { white-space:pre-wrap; font-size:13px; color:var(--mut); background:#fafbfd; }
  .out { white-space:pre-wrap; font-size:14px; line-height:1.7; }
  .tools { display:flex; gap:8px; margin-top:8px; }
  .tools button { flex:1; background:#fff; color:var(--pri); border:1px solid var(--pri); font-size:14px; padding:8px; margin:0; font-weight:500; }
  .tools button:hover:not(:disabled) { background:#eef3ff; }
  .tools button:disabled { border-color:#bbb; color:#999; background:#fff; }
  .tag-group { margin-top:8px; }
  .tag-title { display:block; font-size:12px; color:var(--mut); margin:0 0 4px; }
  .tag-wrap { display:flex; flex-wrap:wrap; margin:-3px; }
  .tag-wrap label { margin:3px; cursor:pointer; }
  .tag-wrap label span { display:inline-block; padding:5px 12px; border:1px solid var(--bd); border-radius:16px; background:#fff; font-size:13px; }
  .tag-wrap label input { display:none; }
  .tag-wrap label input:checked + span { background:var(--pri); color:#fff; border-color:var(--pri); }
  input[type=number], input[type=text], select { width:100%; border:1px solid var(--bd); border-radius:8px; padding:10px; font:inherit; background:#fff; }
  input[type=number]:focus, input[type=text]:focus, select:focus { outline:2px solid var(--pri); border-color:var(--pri); }
  .rec-item { border:1px solid var(--bd); border-radius:10px; padding:12px; margin:10px 0; background:#fafbfd; }
  .rec-song { font-weight:600; font-size:15px; }
  .rec-blessing { white-space:pre-wrap; margin:8px 0; color:var(--text); line-height:1.7; }
  .rec-blessing.loading { color:var(--mut); }
  .rebtn { display:inline-block; background:#fff; color:var(--pri); border:1px solid var(--pri); border-radius:8px; padding:6px 14px; font-size:13px; cursor:pointer; font-weight:500; }
  .rebtn:hover:not(:disabled) { background:#eef3ff; }
  .rebtn:disabled { border-color:#bbb; color:#999; background:#fff; cursor:not-allowed; }
  .song-check { display:block; font-size:14px; padding:6px 4px; border-bottom:1px solid #f0f2f7; cursor:pointer; }
  .song-check input { margin-right:8px; vertical-align:middle; }
  .sort-plan { border:1px solid var(--bd); border-radius:10px; padding:12px; margin:10px 0; background:#fff; }
  .sort-plan-head { display:block; margin-bottom:6px; }
  .sort-plan-name { font-weight:700; font-size:15px; color:var(--pri); }
  .sort-plan-desc { display:block; font-size:12px; color:var(--mut); margin-top:2px; }
  .sort-plan-songs { font-size:13px; line-height:1.7; color:var(--text); background:#fafbfd; border-radius:8px; padding:8px 10px; }
  .sort-song { padding:2px 0; }
  .sort-plan-count { display:flex; align-items:center; margin-top:10px; }
  .sort-plan-count select { width:auto; padding:6px 10px; }
  .pick-count { display:none; position:fixed; right:16px; bottom:calc(40vh + 44px); z-index:999; padding:6px 16px; border-radius:16px; background:var(--pri); color:#fff; font-size:13px; font-weight:600; box-shadow:0 4px 14px rgba(43,108,255,.35); }
  .pick-preview { display:none; position:fixed; right:16px; bottom:16px; z-index:999; width:80%; max-width:340px; max-height:40vh; overflow:auto; padding:10px 14px; border-radius:12px; background:#fff; border:1px solid var(--bd); box-shadow:0 6px 20px rgba(0,0,0,.14); }
  .pick-preview .pp-title { font-size:12px; color:var(--mut); margin-bottom:6px; }
  .pick-preview .pp-item { display:flex; align-items:center; font-size:13px; color:var(--text); padding:4px 0; border-bottom:1px solid #f0f2f7; }
  .pick-preview .pp-item:last-child { border-bottom:none; }
  .pick-preview .pp-info { flex:1; min-width:0; padding-right:6px; }
  .pick-preview .pp-del { flex:none; width:28px; background:#fff; color:#e5484d; border:1px solid var(--bd); border-radius:6px; padding:2px 0; font-size:12px; cursor:pointer; line-height:1.4; text-align:center; }
  .pick-preview .pp-del:hover { background:#fdecec; }
  .link-row { display:flex; align-items:center; margin-top:8px; }
  .link-row .link-inp { flex:1; min-width:0; border:1px solid var(--bd); border-radius:8px; padding:10px; font:inherit; background:#fff; }
  .link-row .link-cnt { width:72px; flex:none; margin-left:6px; border:1px solid var(--bd); border-radius:8px; padding:10px 6px; font:inherit; background:#fff; text-align:center; }
  .link-row .row-del { flex:none; width:36px; margin-left:6px; background:#fff; color:#e5484d; border:1px solid var(--bd); border-radius:8px; padding:10px 0; font:inherit; font-size:14px; cursor:pointer; line-height:1; text-align:center; }
  .link-row .row-del:hover { background:#fdecec; }
  .song-row { display:flex; align-items:center; margin-top:8px; }
  .song-row .song-name { flex:1; min-width:0; border:1px solid var(--bd); border-radius:8px; padding:10px; font:inherit; background:#fff; }
  .song-row .song-singer { width:110px; flex:none; margin-left:6px; border:1px solid var(--bd); border-radius:8px; padding:10px 6px; font:inherit; background:#fff; }
  .song-row .row-del { flex:none; width:36px; margin-left:6px; background:#fff; color:#e5484d; border:1px solid var(--bd); border-radius:8px; padding:10px 0; font:inherit; font-size:14px; cursor:pointer; line-height:1; text-align:center; }
  .song-row .row-del:hover { background:#fdecec; }
  .addbtn { display:inline-block; width:auto; margin-top:8px; background:#fff; color:var(--pri); border:1px dashed var(--pri); border-radius:8px; padding:8px 16px; font:inherit; font-size:14px; font-weight:500; cursor:pointer; }
  .addbtn:hover { background:#eef3ff; }
  footer { text-align:center; color:var(--mut); font-size:11px; margin-top:18px; }
  @media(max-width:480px){ header h1{font-size:18px;} .wrap{padding:10px;} }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🎵 歌单提取</h1>
    <p>粘贴分享链接 → 一键查出全部歌曲及歌手 → 可复制</p>
  </header>
  <div class="card">
    <p class="lbl">分享链接 / 文案（酷狗 / QQ音乐 / 网易云）</p>
    <div id="linkRows"></div>
    <button class="addbtn" onclick="addRow()">＋ 增加一行</button>
    <p class="lbl" style="margin-top:14px">🎤 手动添加歌名（歌手选填）</p>
    <div id="songRows"></div>
    <button class="addbtn" onclick="addSongRow()">＋ 增加歌名</button>
    <p class="lbl" style="margin-top:10px">🔢 提取数量</p>
    <select id="limit">
      <option value="10" selected>10 首</option>
      <option value="20">20 首</option>
      <option value="30">30 首</option>
      <option value="50">50 首</option>
      <option value="100">100 首</option>
      <option value="200">200 首</option>
      <option value="0">全部</option>
    </select>
    <p class="lbl" style="margin-top:10px">🎁 是否生成祝词</p>
    <select id="bless">
      <option value="1" selected>要祝词（AI 生成）</option>
      <option value="0">不要祝词（仅返回歌）</option>
    </select>
    <p class="lbl" style="margin-top:10px">🎁 随机推荐几首（选填，AI 生成祝词）</p>
    <input id="cnt" type="number" min="1" placeholder="例如 1" inputmode="numeric">
    <div class="tag-group" id="tagGroup">
      <span class="tag-title">🏷️ 祝词标签（可多选）</span>
      <span class="tag-title" style="margin-top:4px">节日</span>
      <div class="tag-wrap" id="holidayTags"></div>
      <span class="tag-title" style="margin-top:6px">人际关系</span>
      <div class="tag-wrap" id="relTags"></div>
    </div>
    <p class="lbl" style="margin-top:10px" id="lenLbl">✏️ 祝词字数（选填，默认 50）</p>
    <input id="len" type="number" min="1" placeholder="50" inputmode="numeric">
    <p class="lbl" style="margin-top:10px" id="customLbl">📝 文本指定条件（选填）</p>
    <input id="custom" type="text" placeholder="例如：要喜庆一点、提到龙年、口语化一些……">
    <button id="btn" onclick="run()">🔍 提取歌曲</button>
  </div>
  <div class="card" style="display:none" id="logCard">
    <p class="lbl">运行状态</p>
    <textarea id="log" class="log" readonly rows="5"></textarea>
  </div>
  <div class="card" style="display:none" id="outCard">
    <p class="lbl">📋 结果</p>
    <textarea id="out" class="out" readonly rows="20"></textarea>
    <div id="recList" style="display:none"></div>
    <div id="pickArea" style="display:none">
      <p class="lbl" style="margin-top:12px">🎯 勾选歌曲，为其生成祝词</p>
      <div id="pickCount" class="pick-count">已选 0 首</div>
      <div id="pickPreview" class="pick-preview"></div>
      <div id="songCheckList"></div>
      <button class="rebtn" style="margin-top:10px" onclick="genSelected()">✨ 为选中歌曲生成祝词</button>
      <button class="rebtn" style="margin-top:10px" onclick="sortSelected()">🎧 智能排序播放顺序</button>
      <div class="sort-plan-count">
        <span class="lbl" style="margin:0 8px 0 0">方案数量</span>
        <select id="planCount">
          <option value="5" selected>5 种</option>
          <option value="6">6 种</option>
          <option value="7">7 种</option>
          <option value="8">8 种</option>
          <option value="10">10 种</option>
        </select>
      </div>
      <div id="sortPlanList" style="display:none"></div>
    </div>
    <div class="tools">
      <button onclick="copyPlain()">📋 复制（不带祝词）</button>
      <button onclick="copyWithBlessing()">🎁 复制（带祝词）</button>
      <button onclick="dlOut()">⬇️ 下载 txt</button>
    </div>
  </div>
  <footer>仅用于学习交流</footer>
</div>
<script>
  const HOLIDAY_TAGS = ["春节","元宵节","清明节","端午节","七夕节","中秋节","重阳节","冬至","元旦","情人节","母亲节","父亲节","教师节","国庆节","圣诞节","生日"];
  const REL_TAGS = ["亲情","友情","爱情","兄弟姐妹","闺蜜","女朋友","男朋友","同事","同学","师生","长辈","晚辈","邻里","播间所有人","陌生人"];
  function renderTags(containerId, list) {
    const box = document.getElementById(containerId);
    box.innerHTML = list.map(t =>
      '<label><input type="checkbox" class="tag" value="' + t + '"><span>' + t + '</span></label>'
    ).join('');
  }
  renderTags('holidayTags', HOLIDAY_TAGS);
  renderTags('relTags', REL_TAGS);

  function addRow(link, cnt) {
    const box = document.getElementById('linkRows');
    const row = document.createElement('div');
    row.className = 'link-row';
    row.innerHTML = '<input type="text" class="link-inp" placeholder="粘贴分享链接或文案">' +
      '<input type="number" class="link-cnt" min="1" placeholder="数量" inputmode="numeric">' +
      '<button class="row-del" onclick="removeRow(this)">✕</button>';
    box.appendChild(row);
    if (link) row.querySelector('.link-inp').value = link;
    if (cnt) row.querySelector('.link-cnt').value = cnt;
    refreshRowDels();
  }
  function removeRow(btn) {
    const row = btn.parentNode;
    const box = document.getElementById('linkRows');
    if (box.children.length <= 1) return;
    box.removeChild(row);
    refreshRowDels();
  }
  function refreshRowDels() {
    const dels = document.querySelectorAll('#linkRows .row-del');
    const show = dels.length > 1;
    dels.forEach(b => { b.style.display = show ? '' : 'none'; });
  }
  function collectText() {
    const rows = document.querySelectorAll('#linkRows .link-row');
    const lines = [];
    rows.forEach(r => {
      const link = r.querySelector('.link-inp').value.trim();
      const cnt = r.querySelector('.link-cnt').value.trim();
      if (!link) return;
      lines.push(cnt ? (link + ' ' + cnt) : link);
    });
    return lines.join("\\n");
  }
  addRow();

  function addSongRow(name, singer) {
    const box = document.getElementById('songRows');
    const row = document.createElement('div');
    row.className = 'song-row';
    row.innerHTML = '<input type="text" class="song-name" placeholder="歌名">' +
      '<input type="text" class="song-singer" placeholder="歌手（选填）">' +
      '<button class="row-del" onclick="removeSongRow(this)">✕</button>';
    box.appendChild(row);
    if (name) row.querySelector('.song-name').value = name;
    if (singer) row.querySelector('.song-singer').value = singer;
    refreshSongRowDels();
  }
  function removeSongRow(btn) {
    const row = btn.parentNode;
    const box = document.getElementById('songRows');
    if (box.children.length <= 1) return;
    box.removeChild(row);
    refreshSongRowDels();
  }
  function refreshSongRowDels() {
    const dels = document.querySelectorAll('#songRows .row-del');
    const show = dels.length > 1;
    dels.forEach(b => { b.style.display = show ? '' : 'none'; });
  }
  function collectManualSongs() {
    const rows = document.querySelectorAll('#songRows .song-row');
    const list = [];
    rows.forEach(r => {
      const name = r.querySelector('.song-name').value.trim();
      const singer = r.querySelector('.song-singer').value.trim();
      if (!name) return;
      list.push({ name, singer });
    });
    return list;
  }
  addSongRow();

  let P = null;
  let SEL_IDX = [];
  let SORT_PLANS = [];

  function getTags() {
    return Array.from(document.querySelectorAll('.tag:checked')).map(c => c.value);
  }
  function getWordLimit() {
    return parseInt(document.getElementById('len').value, 10) || 50;
  }
  function getCustom() {
    return document.getElementById('custom').value.trim();
  }
  function getWantBlessing() {
    return document.getElementById('bless').value !== '0';
  }
  function onBlessChange() {
    const want = getWantBlessing();
    document.getElementById('tagGroup').style.display = want ? '' : 'none';
    document.getElementById('lenLbl').style.display = want ? '' : 'none';
    document.getElementById('len').style.display = want ? '' : 'none';
    const customLbl = document.getElementById('customLbl');
    const customInput = document.getElementById('custom');
    if (want) {
      customLbl.textContent = '📝 文本指定条件（选填）';
      customInput.placeholder = '例如：要喜庆一点、提到龙年、口语化一些……';
    } else {
      customLbl.textContent = '🔍 按条件筛选歌单（选填）';
      customInput.placeholder = '例如：只要慢歌、只要周杰伦的歌、粤语歌……';
    }
  }
  document.getElementById('bless').addEventListener('change', onBlessChange);
  onBlessChange();
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function buildTextFromPicks() {
    const lines = ["歌单：《" + P.title + "》  已选 " + P.picks.length + " 首（附祝词）", "=".repeat(40)];
    P.picks.forEach((p, i) => {
      lines.push(String(i + 1).padStart(3, " ") + ". " + p.name + " —— " + p.singer);
      lines.push("     🎁 祝词：" + p.blessing);
    });
    lines.push("=".repeat(40));
    return lines.join("\\n");
  }
  function orderText() {
    const list = P.order || P.songs || [];
    const lines = ["歌单：《" + P.title + "》  共 " + list.length + " 首", "=".repeat(40)];
    list.forEach((s, i) => {
      lines.push(String(i + 1).padStart(3, " ") + ". " + s.name + " —— " + s.singer);
    });
    lines.push("=".repeat(40));
    lines.push("合计 " + list.length + " 首");
    return lines.join("\\n");
  }
  function currentText() {
    if (P && P.picks && P.picks.length) return buildTextFromPicks();
    return orderText();
  }
  function renderPicks() {
    const box = document.getElementById('recList');
    box.innerHTML = P.picks.map((p, i) =>
      '<div class="rec-item">' +
        '<div class="rec-song">' + (i + 1) + '. ' + escapeHtml(p.name) + ' —— ' + escapeHtml(p.singer) + '</div>' +
        '<div class="rec-blessing" id="bless-' + i + '">🎁 祝词：' + escapeHtml(p.blessing) + '</div>' +
        '<button class="rebtn" id="rebtn-' + i + '" onclick="regen(' + i + ')">🔄 重新生成祝词</button>' +
      '</div>'
    ).join('');
  }
  async function regen(i) {
    const p = P.picks[i];
    const btn = document.getElementById('rebtn-' + i);
    const blessEl = document.getElementById('bless-' + i);
    btn.disabled = true;
    blessEl.classList.add('loading');
    blessEl.textContent = '🎁 正在生成新祝词…';
    try {
      const r = await fetch('/rebless', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ songName: p.name, singer: p.singer, tags: getTags(), wordLimit: getWordLimit(), custom: getCustom() }) });
      const d = await r.json();
      if (d.blessing) {
        p.blessing = d.blessing;
        blessEl.textContent = '🎁 祝词：' + d.blessing;
      } else {
        p.blessing = '（生成失败）';
        blessEl.textContent = '🎁 祝词：（生成失败：' + (d.error || '未知错误') + '）';
      }
    } catch (e) {
      p.blessing = '（请求失败）';
      blessEl.textContent = '🎁 祝词：（请求失败：' + e.message + '）';
    }
    blessEl.classList.remove('loading');
    btn.disabled = false;
    document.getElementById('out').value = currentText();
  }

  function showResult() {
    const outEl = document.getElementById('out');
    const recEl = document.getElementById('recList');
    const pickEl = document.getElementById('pickArea');
    if (P.picks && P.picks.length) {
      outEl.style.display = 'none';
      recEl.style.display = '';
      pickEl.style.display = 'none';
      renderPicks();
    } else {
      outEl.style.display = '';
      recEl.style.display = 'none';
      outEl.value = orderText();
      if (P.songs && P.songs.length) {
        pickEl.style.display = '';
        renderSongCheckList();
      } else {
        pickEl.style.display = 'none';
      }
    }
  }

  function renderSongCheckList() {
    const box = document.getElementById('songCheckList');
    box.innerHTML = P.songs.map((s, i) =>
      '<label class="song-check"><input type="checkbox" class="songpick" value="' + i + '">' + (i + 1) + '. ' + escapeHtml(s.name) + ' —— ' + escapeHtml(s.singer) + '</label>'
    ).join('');
    updatePickCount();
  }

  function updatePickCount() {
    const checked = Array.from(document.querySelectorAll('.songpick:checked')).map(c => parseInt(c.value, 10));
    const n = checked.length;
    const el = document.getElementById('pickCount');
    el.textContent = '已选 ' + n + ' 首';
    el.style.display = n > 0 ? 'inline-block' : 'none';

    const pv = document.getElementById('pickPreview');
    if (n > 0) {
      const items = checked.map(i => {
        const s = P.songs[i];
        return '<div class="pp-item">' +
          '<span class="pp-info">' + (i + 1) + '. ' + escapeHtml(s.name) + ' —— ' + escapeHtml(s.singer) + '</span>' +
          '<button class="pp-del" onclick="removePick(' + i + ')">✕</button>' +
        '</div>';
      }).join('');
      pv.innerHTML = '<div class="pp-title">已选歌曲预览</div>' + items;
      pv.style.display = 'block';
    } else {
      pv.style.display = 'none';
    }
  }

  function removePick(i) {
    if (!confirm('确定从已选中删除这首歌吗？')) return;
    const cb = document.querySelector('.songpick[value="' + i + '"]');
    if (cb) cb.checked = false;
    updatePickCount();
  }

  // 勾选歌曲变化时，更新显眼的已选数量
  document.addEventListener('change', e => {
    if (e.target && e.target.classList && e.target.classList.contains('songpick')) updatePickCount();
  });

  async function genSelected() {
    const idxs = Array.from(document.querySelectorAll('.songpick:checked')).map(c => parseInt(c.value, 10));
    if (!idxs.length) { alert('请先勾选歌曲'); return; }
    // 按勾选顺序（歌单原始顺序）确定当前歌单顺序
    P.order = idxs.map(i => ({ name: P.songs[i].name, singer: P.songs[i].singer }));
    await generateBlessings();
  }

  async function generateBlessings() {
    if (!P.order || !P.order.length) { alert('没有歌曲可生成祝词'); return; }
    P.picks = P.order.map(s => ({ name: s.name, singer: s.singer, blessing: '' }));
    showResult();
    for (let i = 0; i < P.picks.length; i++) {
      await regen(i);
    }
  }

  async function sortSelected() {
    const idxs = Array.from(document.querySelectorAll('.songpick:checked')).map(c => parseInt(c.value, 10));
    if (!idxs.length) { alert('请先勾选歌曲'); return; }
    if (idxs.length < 2) { alert('至少勾选 2 首才能智能排序'); return; }
    SEL_IDX = idxs.slice();
    const songs = idxs.map(i => ({ name: P.songs[i].name, singer: P.songs[i].singer }));
    const box = document.getElementById('sortPlanList');
    box.style.display = '';
    box.innerHTML = '<p class="lbl">🎧 正在分析歌曲，生成多种播放顺序方案…</p>';
    try {
      const planCount = parseInt(document.getElementById('planCount').value, 10) || 5;
      const r = await fetch('/sort', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ songs, planCount }) });
      const d = await r.json();
      if (!d.plans || !d.plans.length) throw new Error(d.error || '未生成方案');
      SORT_PLANS = d.plans;
      renderSortPlans();
    } catch (e) {
      box.innerHTML = '<p class="lbl">智能排序失败：' + escapeHtml(e.message) + '</p>';
    }
  }

  function renderSortPlans() {
    const box = document.getElementById('sortPlanList');
    box.innerHTML = '<p class="lbl">🎧 推荐多种播放顺序（点击采用）</p>' + SORT_PLANS.map((p, pi) =>
      '<div class="sort-plan">' +
        '<div class="sort-plan-head"><span class="sort-plan-name">' + escapeHtml(p.name) + '</span>' +
        (p.desc ? '<span class="sort-plan-desc">' + escapeHtml(p.desc) + '</span>' : '') + '</div>' +
        '<div class="sort-plan-songs">' + p.order.map((oi, k) => {
          const s = P.songs[SEL_IDX[oi]];
          return '<div class="sort-song">' + (k + 1) + '. ' + escapeHtml(s.name) + ' —— ' + escapeHtml(s.singer) + '</div>';
        }).join('') + '</div>' +
        '<button class="rebtn" style="margin-top:8px" onclick="applySortPlan(' + pi + ')">✅ 采用此顺序</button>' +
      '</div>'
    ).join('');
  }

  async function applySortPlan(pi) {
    const plan = SORT_PLANS[pi];
    if (!plan) return;
    // plan.order 是相对 SEL_IDX 的 0 基索引，映射回 P.songs 真实下标
    const ordered = plan.order.map(oi => SEL_IDX[oi]);
    // 只确认顺序，不立即生成祝词；祝词由「复制（带祝词）」或「勾选生成祝词」触发
    P.order = ordered.map(i => ({ name: P.songs[i].name, singer: P.songs[i].singer }));
    document.getElementById('sortPlanList').style.display = 'none';
    P.picks = [];
    showResult();
  }

  async function run() {
    const text = collectText();
    const manualSongs = collectManualSongs();
    if (!text && !manualSongs.length) { alert('请先粘贴分享链接或手动添加歌名'); return; }
    const count = parseInt(document.getElementById('cnt').value, 10) || 0;
    const limit = parseInt(document.getElementById('limit').value, 10) || 0;
    const tags = getTags();
    const wordLimit = getWordLimit();
    const custom = getCustom();
    const wantBlessing = getWantBlessing();
    const btn = document.getElementById('btn');
    btn.disabled = true; btn.textContent = (count > 0 && wantBlessing) ? '⏳ 正在查询并生成祝词…' : '⏳ 正在查询…';
    document.getElementById('logCard').style.display = '';
    document.getElementById('outCard').style.display = 'none';
    const logEl = document.getElementById('log');
    logEl.value = '正在请求服务…';
    try {
      const r = await fetch('/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text, count, limit, tags, wordLimit, custom, wantBlessing, manualSongs}) });
      const d = await r.json();
      logEl.value = d.status || '';
      if (d.out) {
        const titleM = d.out.match(/歌单：《(.+?)》/);
        const rawSongs = d.songs || [];
        const rawPicks = d.picks || [];
        P = {
          title: titleM ? titleM[1] : '歌单',
          out: d.out,
          picks: rawPicks,
          songs: rawSongs,
          // 已确认顺序：有推荐结果时取推荐歌，否则取完整歌单
          order: rawPicks.length ? rawPicks.map(p => ({ name: p.name, singer: p.singer })) : rawSongs.slice(),
          wantBlessing
        };
        document.getElementById('outCard').style.display = '';
        showResult();
      }
    } catch (e) {
      logEl.value = '请求失败：' + e.message + '\\n（服务可能冷启动，请稍等几秒后重试）';
    }
    btn.disabled = false; btn.textContent = '🔍 提取歌曲';
  }
  async function doCopy(t) {
    if (!t) return;
    try { await navigator.clipboard.writeText(t); alert('已复制！'); }
    catch (e) {
      const el = document.getElementById('out');
      const prev = el.style.display;
      el.style.display = '';
      el.value = t;
      el.select(); el.setSelectionRange(0, 99999);
      try { document.execCommand('copy'); alert('已复制！'); } catch (e2) { alert('复制失败，请长按结果手动复制'); }
      el.style.display = prev;
    }
  }
  function copyPlain() {
    doCopy(orderText());
  }
  async function copyWithBlessing() {
    // 若无祝词，则先按当前已确认顺序生成祝词（可反复重新生成）
    if (!(P.picks && P.picks.length && P.picks.every(p => p.blessing))) {
      await generateBlessings();
      if (!(P.picks && P.picks.length)) return;
      alert('祝词已生成，可在下方逐首「重新生成」，满意后再次点击「复制（带祝词）」');
      return;
    }
    doCopy(buildTextFromPicks());
  }
  function dlOut() {
    const t = currentText();
    if (!t) return;
    const m = t.match(/歌单：《(.+?)》/);
    const name = (m ? m[1] : '歌单').replace(/[\\\\\\/:*?\\"<>|]/g, '_');
    const blob = new Blob([t], { type:'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '歌单_' + name + '.txt';
    a.click();
  }
  document.querySelector('#linkRows').addEventListener('paste', e => {
    if (e.target.classList && e.target.classList.contains('link-inp')) setTimeout(run, 50);
  });
</script>
</body>
</html>`;
