/* Northants Bitcoin Network — reads posts live from Nostr relays.
   No build step, no dependencies, no backend. */
(function () {
  "use strict";

  /* Settings come from assets/config.js; these are the fallbacks if it is
     missing or a value has been deleted. */
  var CFG = window.SITE_CONFIG || {};
  var ACCOUNT = CFG.npub || "";

  var RELAYS = (Array.isArray(CFG.relays) ? CFG.relays : [])
    .map(function (r) { return String(r).trim(); })
    .filter(function (r, i, all) { return /^wss?:\/\/.+/i.test(r) && all.indexOf(r) === i; });

  var FAVICON = String(CFG.favicon || "").trim();

  var CONTACT = CFG.contact || {};
  var LINKS = (Array.isArray(CONTACT.links) ? CONTACT.links : []).filter(function (l) {
    return l && String(l.url || "").trim() && String(l.label || "").trim();
  });

  var PER_PAGE = Math.max(1, parseInt(CFG.perPage, 10) || 20);

  /* Optional pages, all on unless config.js says otherwise. */
  var PAGES = {};
  ["topics", "gallery", "calendar", "articles", "mentions", "about"].forEach(function (k) {
    var v = (CFG.pages || {})[k];
    PAGES[k] = v === undefined ? true : !!v;
  });

  /* The extra kinds are only worth asking the relays for if their page is on. */
  var KINDS = [0, 1];
  if (PAGES.calendar) KINDS = KINDS.concat([31922, 31923]);
  if (PAGES.articles) KINDS = KINDS.concat([30023]);
  var CACHE_KEY = "nbn-events-v1";   // scoped per account below, so switching keys never shows stale posts
  var TIMEOUT_MS = 9000;

  // ---------- bech32 (NIP-19 npub / note identifiers) ----------
  var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

  function polymod(values) {
    var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var chk = 1;
    for (var p = 0; p < values.length; ++p) {
      var top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[p];
      for (var i = 0; i < 5; ++i) if ((top >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }

  function hrpExpand(hrp) {
    var out = [], i;
    for (i = 0; i < hrp.length; ++i) out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for (i = 0; i < hrp.length; ++i) out.push(hrp.charCodeAt(i) & 31);
    return out;
  }

  function convertBits(data, from, to, pad) {
    var acc = 0, bits = 0, ret = [], maxv = (1 << to) - 1;
    for (var i = 0; i < data.length; ++i) {
      acc = (acc << from) | data[i];
      bits += from;
      while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); }
    }
    if (pad && bits > 0) ret.push((acc << (to - bits)) & maxv);
    return ret;
  }

  function bech32Encode(hrp, hexStr) {
    var bytes = [];
    for (var i = 0; i < hexStr.length; i += 2) bytes.push(parseInt(hexStr.substr(i, 2), 16));
    var data = convertBits(bytes, 8, 5, true);
    var values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
    var mod = polymod(values) ^ 1;
    var checksum = [];
    for (var p = 0; p < 6; ++p) checksum.push((mod >> (5 * (5 - p))) & 31);
    var out = hrp + "1";
    data.concat(checksum).forEach(function (d) { out += CHARSET.charAt(d); });
    return out;
  }

  function bech32Parse(str) {
    var s = String(str).trim().replace(/^nostr:/, "");
    var lower = s.toLowerCase();
    if (s !== lower && s !== s.toUpperCase()) throw new Error("mixed case");
    s = lower;

    var pos = s.lastIndexOf("1");
    if (pos < 1 || pos + 7 > s.length) throw new Error("not a bech32 string");
    var hrp = s.slice(0, pos), data = [], i;
    for (i = pos + 1; i < s.length; ++i) {
      var d = CHARSET.indexOf(s.charAt(i));
      if (d === -1) throw new Error("bad character '" + s.charAt(i) + "'");
      data.push(d);
    }
    if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error("bad checksum");
    return { hrp: hrp, bytes: convertBits(data.slice(0, -6), 5, 8, false) };
  }

  function toHex(bytes) {
    var hex = "";
    for (var i = 0; i < bytes.length; ++i) hex += ("0" + bytes[i].toString(16)).slice(-2);
    return hex;
  }

  function bech32Decode(str) {
    var s = String(str).trim().replace(/^nostr:/, "");
    if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
    var r = bech32Parse(s);
    if (r.hrp !== "npub") throw new Error("expected an npub, got '" + r.hrp + "'");
    if (r.bytes.length !== 32) throw new Error("wrong key length");
    return toHex(r.bytes);
  }

  /* note1 is the bare event id; nevent1 wraps it in TLV records, type 0 being the id. */
  function quoteKey(id) {
    try {
      var r = bech32Parse(id);
      if (r.hrp === "note") return r.bytes.length === 32 ? toHex(r.bytes) : "";
      if (r.hrp !== "nevent") return "";
      var b = r.bytes, i = 0;
      while (i + 2 <= b.length) {
        var type = b[i], len = b[i + 1];
        if (type === 0 && len === 32) return toHex(b.slice(i + 2, i + 34));
        i += 2 + len;
      }
    } catch (err) { /* not a valid identifier — leave the text alone */ }
    return "";
  }

  /* An nevent also carries relay hints (TLV type 1): the relays the author
     saw the quoted event on. Without them a quote that lives nowhere in
     config.js can never be found. */
  function quoteHints(id) {
    var out = [];
    try {
      var r = bech32Parse(id);
      if (r.hrp !== "nevent") return out;
      var b = r.bytes, i = 0;
      while (i + 2 <= b.length) {
        var type = b[i], len = b[i + 1];
        if (type === 1 && len) {
          var url = "";
          for (var j = i + 2; j < i + 2 + len && j < b.length; ++j) url += String.fromCharCode(b[j]);
          if (/^wss?:\/\/.+/i.test(url)) out.push(url.trim());
        }
        i += 2 + len;
      }
    } catch (err) { /* not a valid identifier — no hints to take */ }
    return out;
  }

  /* npub is the bare key; nprofile wraps it in TLV records, type 0 being the key. */
  function mentionKey(id) {
    try {
      var r = bech32Parse(id);
      if (r.hrp === "npub") return r.bytes.length === 32 ? toHex(r.bytes) : "";
      if (r.hrp !== "nprofile") return "";
      var b = r.bytes, i = 0;
      while (i + 2 <= b.length) {
        var type = b[i], len = b[i + 1];
        if (type === 0 && len === 32) return toHex(b.slice(i + 2, i + 34));
        i += 2 + len;
      }
    } catch (err) { /* not a valid identifier — leave the text alone */ }
    return "";
  }

  var PUBKEY, KEY_ERROR = "";
  try {
    if (!ACCOUNT) throw new Error("no npub set");
    if (!RELAYS.length) throw new Error("no relays set");
    PUBKEY = bech32Decode(ACCOUNT);
    CACHE_KEY += "-" + PUBKEY.slice(0, 12);
  } catch (e) {
    KEY_ERROR = e.message;
  }

  // ---------- tiny helpers ----------
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(ts) {
    var d = new Date(ts * 1000);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function relTime(ts) {
    var secs = Math.floor(Date.now() / 1000) - ts;
    var units = [[31536000, "year"], [2592000, "month"], [604800, "week"],
                 [86400, "day"], [3600, "hour"], [60, "minute"]];
    for (var i = 0; i < units.length; i++) {
      var n = Math.floor(secs / units[i][0]);
      if (n >= 1) return n + " " + units[i][1] + (n > 1 ? "s" : "") + " ago";
    }
    return "just now";
  }

  // ---------- state ----------
  var events = new Map();
  var profile = null;
  var relayStats = {};
  var renderQueued = false;
  var lastViewKey = "";

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      JSON.parse(raw).forEach(function (e) { events.set(e.id, e); });
      absorbProfile();
    } catch (e) { /* private mode, blocked storage, corrupt entry — ignore */ }
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Array.from(events.values()).slice(0, 400)));
    } catch (e) { /* quota or blocked — the site works fine without the cache */ }
  }

  /* ---- names for mentioned accounts ----
     Their kind 0 events are not part of this account's feed, so they are
     fetched on demand and cached; the view re-renders as each one lands. */
  var NAME_KEY = "nbn-names-v1";
  var names = {};
  try { names = JSON.parse(localStorage.getItem(NAME_KEY) || "{}") || {}; } catch (e) { names = {}; }
  var nameWanted = {};
  var nameTimer = null;
  var nameHooks = [];   // redraw callbacks for anything outside the main view

  function needName(pk) {
    if (!pk || names[pk] !== undefined || nameWanted[pk]) return;
    nameWanted[pk] = true;
    clearTimeout(nameTimer);
    nameTimer = setTimeout(fetchNames, 250);
  }

  function fetchNames() {
    var want = Object.keys(nameWanted).filter(function (pk) { return names[pk] === undefined; });
    if (!want.length || !RELAYS.length) return;
    var found = false;

    RELAYS.forEach(function (url) {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { return; }
      var timer = setTimeout(shut, TIMEOUT_MS);

      function shut() {
        clearTimeout(timer);
        try { ws.close(); } catch (e) { /* already closed */ }
      }

      ws.onopen = function () {
        ws.send(JSON.stringify(["REQ", "names", { authors: want, kinds: [0], limit: want.length }]));
      };
      ws.onerror = shut;
      ws.onmessage = function (msg) {
        var data;
        try { data = JSON.parse(msg.data); } catch (e) { return; }
        if (data[0] === "EOSE") return shut();
        if (data[0] !== "EVENT" || !data[2] || data[2].kind !== 0) return;
        var ev = data[2], meta;
        try { meta = JSON.parse(ev.content); } catch (e) { return; }
        var name = String(meta.display_name || meta.name || "").trim().slice(0, 40);
        if (!name || names[ev.pubkey]) return;
        names[ev.pubkey] = name;
        found = true;
        try { localStorage.setItem(NAME_KEY, JSON.stringify(names)); } catch (e) { /* blocked */ }
        queueRender();
        nameHooks.forEach(function (fn) { fn(); });
        refreshModal();
      };
      ws.onclose = function () {
        clearTimeout(timer);
        // Anything still unnamed after every relay has spoken keeps its short form.
        if (!found) want.forEach(function (pk) { if (names[pk] === undefined) names[pk] = ""; });
      };
    });
  }

  function personName(pk) {
    return names[pk] ? "@" + names[pk] : bech32Encode("npub", pk).slice(0, 12) + "\u2026";
  }

  /* ---- quoted notes ----
     A note1/nevent1 in a post is shown inline. The event is usually somebody
     else's, so it is fetched on its own and kept out of the feed's store. */
  var quotes = {};
  var quoteWanted = {};
  var quoteHosts = [];   // relay hints picked up from the nevents themselves
  var quoteTimer = null;

  function quoteOf(id) {
    return events.get(id) || quotes[id] || null;
  }

  function needQuote(id, bech) {
    if (!id || quoteOf(id) || quoteWanted[id]) return;
    quoteWanted[id] = true;
    quoteHints(bech || "").forEach(function (url) {
      if (RELAYS.indexOf(url) === -1 && quoteHosts.indexOf(url) === -1) quoteHosts.push(url);
    });
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(fetchQuotes, 250);
  }

  function fetchQuotes() {
    var want = Object.keys(quoteWanted).filter(function (id) { return !quoteOf(id); });
    var where = RELAYS.concat(quoteHosts);
    if (!want.length || !where.length) return;

    where.forEach(function (url) {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { return; }
      var timer = setTimeout(shut, TIMEOUT_MS);

      function shut() {
        clearTimeout(timer);
        try { ws.close(); } catch (e) { /* already closed */ }
      }

      ws.onopen = function () {
        ws.send(JSON.stringify(["REQ", "quotes", { ids: want, limit: want.length }]));
      };
      ws.onerror = shut;
      ws.onclose = function () { clearTimeout(timer); };
      ws.onmessage = function (msg) {
        var data;
        try { data = JSON.parse(msg.data); } catch (e) { return; }
        if (data[0] === "EOSE") return shut();
        if (data[0] !== "EVENT" || !data[2] || !data[2].id || quotes[data[2].id]) return;
        quotes[data[2].id] = data[2];
        needName(data[2].pubkey);
        queueRender();
        refreshModal();
      };
    });
  }

  function absorbProfile() {
    events.forEach(function (e) {
      if (e.kind === 0) {
        try {
          var p = JSON.parse(e.content);
          if (!profile || e.created_at >= profile._at) { p._at = e.created_at; profile = p; }
        } catch (err) { /* malformed profile event */ }
      }
    });
  }

  function notes() {
    var out = [];
    events.forEach(function (e) { if (e.kind === 1 && e.pubkey === PUBKEY) out.push(e); });
    return out.sort(function (a, b) { return b.created_at - a.created_at; });
  }

  /* Posts by other people that tag this account. */
  function mentions() {
    var out = [];
    events.forEach(function (e) {
      if (e.kind !== 1 || e.pubkey === PUBKEY) return;
      var hit = (e.tags || []).some(function (t) { return t[0] === "p" && t[1] === PUBKEY; });
      if (hit) out.push(e);
    });
    return out.sort(function (a, b) { return b.created_at - a.created_at; });
  }

  function isReply(ev) {
    return (ev.tags || []).some(function (t) { return t[0] === "e"; });
  }

  function hashtagsOf(ev) {
    var set = [];
    function add(v) {
      v = String(v).toLowerCase().replace(/^#/, "").trim();
      // Some events cram several hashtags into one "t" tag; keep only clean words.
      if (/^[\p{L}\p{N}_-]{2,30}$/u.test(v) && set.indexOf(v) === -1) set.push(v);
    }
    (ev.tags || []).forEach(function (t) {
      if (t[0] === "t" && t[1]) String(t[1]).split(/[\s#,]+/).forEach(add);
    });
    // Fall back to parsing the body when the author didn't add "t" tags.
    var m = String(ev.content).match(/(?:^|\s)#([\p{L}\p{N}_-]{2,30})/gu);
    if (m) m.forEach(function (raw) { add(raw.trim()); });
    return set;
  }

  var IMG_RE = /https?:\/\/[^\s<>"']+?\.(?:jpe?g|png|gif|webp|avif)(?:\?[^\s<>"']*)?/gi;

  function imagesOf(ev) {
    var urls = [];
    function add(u) {
      u = String(u).replace(/[.,;:!?)\]]+$/, "").trim();
      if (/^https?:\/\//i.test(u) && urls.indexOf(u) === -1) urls.push(u);
    }
    // NIP-92 media metadata is more reliable than scraping the body, so try it first.
    (ev.tags || []).forEach(function (t) {
      if (t[0] !== "imeta") return;
      t.slice(1).forEach(function (part) {
        var m = /^url\s+(\S+)/.exec(String(part));
        if (m && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(m[1])) add(m[1]);
      });
    });
    var found = String(ev.content || "").match(IMG_RE);
    if (found) found.forEach(add);
    return urls;
  }

  function galleryItems() {
    var out = [];
    notes().forEach(function (ev) {
      imagesOf(ev).forEach(function (url) { out.push({ url: url, ev: ev }); });
    });
    return out;
  }

  function tagValue(ev, name) {
    var hit = (ev.tags || []).find(function (t) { return t[0] === name && t[1]; });
    return hit ? String(hit[1]) : "";
  }

  /* NIP-52: 31922 is an all-day event keyed by date, 31923 by unix timestamp. */
  function calendarEvents() {
    var out = [];
    events.forEach(function (ev) {
      if (ev.kind !== 31922 && ev.kind !== 31923) return;
      var allDay = ev.kind === 31922;
      var raw = tagValue(ev, "start");
      if (!raw) return;
      var start = allDay ? Date.parse(raw + "T00:00:00") / 1000 : parseInt(raw, 10);
      if (!start || isNaN(start)) return;
      var endRaw = tagValue(ev, "end");
      var end = endRaw ? (allDay ? Date.parse(endRaw + "T00:00:00") / 1000 : parseInt(endRaw, 10)) : 0;
      out.push({
        ev: ev, start: start, end: end || 0, allDay: allDay,
        title: tagValue(ev, "title") || tagValue(ev, "name") || "Untitled event",
        location: tagValue(ev, "location"),
        geohash: tagValue(ev, "g"),
        image: tagValue(ev, "image"),
        summary: tagValue(ev, "summary") || String(ev.content || "")
      });
    });
    var now = Date.now() / 1000;
    var upcoming = out.filter(function (e) { return (e.end || e.start) >= now; })
                      .sort(function (a, b) { return a.start - b.start; });
    var past = out.filter(function (e) { return (e.end || e.start) < now; })
                  .sort(function (a, b) { return b.start - a.start; });
    return { upcoming: upcoming, past: past, all: upcoming.concat(past) };
  }

  // ---------- content rendering ----------
  var TOKEN = /(https?:\/\/[^\s<]+)|(?:nostr:)?((?:npub|note|nevent|nprofile|naddr)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,})|(^|\s)#([\p{L}\p{N}_-]{2,30})/gu;

  function renderContent(text, depth) {
    depth = depth || 0;
    var src = String(text || "");
    var out = "", last = 0, m;
    // A fresh regex each call: a quoted note renders through here recursively,
    // and a shared lastIndex would restart the outer scan forever.
    var token = new RegExp(TOKEN.source, TOKEN.flags);
    while ((m = token.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      last = m.index + m[0].length;

      if (m[1]) {
        var url = m[1].replace(/[.,;:!?)\]]+$/, "");
        last = m.index + m[1].indexOf(url) + url.length;
        var safe = esc(url);
        if (/\.(jpe?g|png|gif|webp|avif)(\?.*)?$/i.test(url)) {
          out += '<img src="' + safe + '" alt="" loading="lazy">';
        } else if (/\.(mp4|webm|mov)(\?.*)?$/i.test(url)) {
          out += '<video src="' + safe + '" controls preload="metadata"></video>';
        } else {
          out += '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + safe + '</a>';
        }
      } else if (m[2]) {
        var id = m[2];
        var pk = mentionKey(id);
        var qid = pk ? "" : quoteKey(id);
        if (pk) needName(pk);
        // Only one level deep: a quote inside a quote stays a plain link.
        if (qid && depth < 1) {
          needQuote(qid, id);
          out += quoteCard(qid, id);
        } else {
          var label = pk && names[pk] ? "@" + esc(names[pk]) : esc(id.slice(0, 12)) + "…";
          out += '<a class="mention" href="https://njump.me/' + esc(id) +
                 '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
        }
      } else if (m[4]) {
        var tag = m[4];
        out += esc(m[3]) + '<a class="hashtag" href="#/tag/' + encodeURIComponent(tag.toLowerCase()) +
               '">#' + esc(tag) + '</a>';
      }
    }
    out += esc(src.slice(last));
    return out;
  }

  function hasSelection() {
    var sel = window.getSelection();
    return !!sel && !sel.isCollapsed && String(sel).length > 0;
  }

  /* Built from spans, so it stays valid inside a paragraph of article text. */
  function quoteCard(id, bech) {
    var ev = quoteOf(id);
    if (!ev) {
      return '<a class="mention" href="https://njump.me/' + esc(bech) +
             '" target="_blank" rel="noopener noreferrer">' + esc(bech.slice(0, 12)) + '\u2026</a>';
    }
    var npub = bech32Encode("npub", ev.pubkey);
    return '<span class="quote">' +
           '<span class="quote-head">' +
           '<a class="note-author" href="https://njump.me/' + esc(npub) +
           '" target="_blank" rel="noopener noreferrer">' + esc(personName(ev.pubkey)) + '</a>' +
           '<span class="quote-date">' + esc(fmtDate(ev.created_at)) + '</span></span>' +
           '<span class="quote-body">' + renderContent(ev.content, 1) + '</span></span>';
  }

  function noteCard(ev, opts) {
    opts = opts || {};
    var tags = hashtagsOf(ev);
    // In a feed the whole card opens the note in the overlay; on its own page
    // there is nowhere to go.
    var open = opts.single ? "" : ' data-note="' + esc(ev.id) + '" tabindex="0" role="button"';
    var html = '<article class="note"' + open + '>';
    html += '<div class="note-head">';
    if (opts.author) {
      needName(ev.pubkey);
      html += '<a class="note-author" href="https://njump.me/' + esc(bech32Encode("npub", ev.pubkey)) +
              '" target="_blank" rel="noopener noreferrer">' + esc(personName(ev.pubkey)) + '</a>';
    }
    html += '<time class="note-date" datetime="' + new Date(ev.created_at * 1000).toISOString() + '">' +
            fmtDate(ev.created_at) + ' · ' + relTime(ev.created_at) + '</time>';
    if (isReply(ev)) html += '<span class="badge">Reply</span>';
    html += '</div>';
    html += '<div class="note-body">' + renderContent(ev.content) + '</div>';
    // In a card the media is shown as one thumbnail below the text, so that
    // clamping the text can never collide with it.
    var thumb = opts.single ? "" : (imagesOf(ev)[0] || "");
    if (thumb) html += '<img class="note-thumb" src="' + esc(thumb) + '" alt="" loading="lazy">';
    html += '<div class="note-foot">';
    tags.forEach(function (t) {
      html += '<a class="hashtag" href="#/tag/' + encodeURIComponent(t) + '">#' + esc(t) + '</a>';
    });
    html += '</div></article>';
    return html;
  }

  function galleryTile(item) {
    var nid = bech32Encode("note", item.ev.id);
    // A real link, so it can still be copied or opened in a tab, but a click
    // opens the overlay with its arrows instead of leaving the gallery.
    return '<a class="shot" href="#/note/' + nid + '" data-note="' + esc(item.ev.id) +
           '" title="' + esc(fmtDate(item.ev.created_at)) + '">' +
           '<img src="' + esc(item.url) + '" alt="" loading="lazy">' +
           '<span class="shot-date">' + esc(fmtDate(item.ev.created_at)) + '</span></a>';
  }

  function eventCard(e) {
    var d = new Date(e.start * 1000);
    var when = e.allDay
      ? fmtDate(e.start)
      : fmtDate(e.start) + " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    var img = e.image || imagesOf(e.ev)[0] || "";

    var html = '<article class="event' + (isPast(e) ? " is-past" : "") + '" id="ev-' + esc(e.ev.id) +
               '" data-event="' + esc(e.ev.id) + '" tabindex="0" role="button">';
    html += '<div class="event-head">';
    html += '<div class="event-date"><span class="event-day">' + d.getDate() + '</span>' +
            '<span class="event-mon">' + d.toLocaleDateString("en-GB", { month: "short" }) + '</span></div>';
    html += '<div class="event-headings"><h3 class="event-title">' + esc(e.title) + '</h3>';
    html += '<p class="event-when">' + esc(when) + '</p>';
    if (e.location) html += '<p class="event-where">' + esc(e.location) + '</p>';
    html += '</div></div>';

    // Always emitted, so every card is the same two rows and can share them.
    html += '<div class="event-body">';
    html += '<div class="event-summary">' + (e.summary ? renderContent(e.summary) : "") + '</div>';
    if (img) html += '<img class="event-img" src="' + esc(img) + '" alt="" loading="lazy">';
    html += '</div>';
    return html + '</article>';
  }

  /* ---- month calendar shown above the events ---- */
  var MONTH_MS = null;          // first day of the month on show

  function isPast(e) {
    return (e.end || e.start) < Date.now() / 1000;
  }

  function monthGrid(cal) {
    if (!cal.all.length) return "";

    // Default to the month of the next event, or this month if none are due.
    if (MONTH_MS === null) {
      var seed = new Date((cal.upcoming[0] || cal.all[0]).start * 1000);
      MONTH_MS = new Date(seed.getFullYear(), seed.getMonth(), 1).getTime();
    }
    var cur = new Date(MONTH_MS);
    var year = cur.getFullYear(), month = cur.getMonth();

    // Bucket this month's events by day number.
    var byDay = {};
    cal.all.forEach(function (e) {
      var d = new Date(e.start * 1000);
      if (d.getFullYear() !== year || d.getMonth() !== month) return;
      (byDay[d.getDate()] = byDay[d.getDate()] || []).push(e);
    });

    var first = new Date(year, month, 1);
    var lead = (first.getDay() + 6) % 7;                 // weeks start Monday
    var days = new Date(year, month + 1, 0).getDate();
    var today = new Date();
    var isThisMonth = today.getFullYear() === year && today.getMonth() === month;

    var html = '<div class="cal">';
    html += '<div class="cal-head">';
    html += '<button type="button" class="cal-nav" data-cal="prev" aria-label="Previous month">‹</button>';
    html += '<span class="cal-month">' +
            cur.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) + '</span>';
    html += '<button type="button" class="cal-nav" data-cal="next" aria-label="Next month">›</button>';
    html += '</div><div class="cal-grid">';
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(function (n) {
      html += '<span class="cal-dow">' + n + '</span>';
    });
    for (var i = 0; i < lead; i++) html += '<span class="cal-cell is-blank"></span>';

    for (var day = 1; day <= days; day++) {
      var list = byDay[day] || [];
      var cls = "cal-cell" + (list.length ? " has-events" : "") +
                (isThisMonth && today.getDate() === day ? " is-today" : "");
      if (!list.length) {
        html += '<span class="' + cls + '">' + day + '</span>';
        continue;
      }
      var titles = list.map(function (e) { return e.title; }).join(", ");
      html += '<a class="' + cls + '" href="#/calendar" data-day="' + year + '-' + month + '-' + day +
              '" title="' + esc(titles) + '"><span class="cal-num">' + day + '</span><span class="cal-dots">' +
              list.slice(0, 3).map(function () { return '<i></i>'; }).join("") + '</span></a>';
    }
    return html + '</div></div>';
  }

  /* NIP-52 puts coordinates in a "g" geohash tag; decode it for the map. */
  var GEO32 = "0123456789bcdefghjkmnpqrstuvwxyz";

  function geohashDecode(hash) {
    var lat = [-90, 90], lon = [-180, 180], even = true;
    var h = String(hash).toLowerCase();
    for (var i = 0; i < h.length; i++) {
      var idx = GEO32.indexOf(h.charAt(i));
      if (idx === -1) return null;
      for (var b = 4; b >= 0; b--) {
        var range = even ? lon : lat;
        var mid = (range[0] + range[1]) / 2;
        if ((idx >> b) & 1) range[0] = mid; else range[1] = mid;
        even = !even;
      }
    }
    if (!h.length) return null;
    return { lat: (lat[0] + lat[1]) / 2, lon: (lon[0] + lon[1]) / 2 };
  }

  function mapFrame(pt) {
    var d = 0.006;   // roughly a few streets across
    var box = [pt.lon - d, pt.lat - d / 2, pt.lon + d, pt.lat + d / 2].join(",");
    var osm = "https://www.openstreetmap.org/?mlat=" + pt.lat + "&mlon=" + pt.lon + "#map=16/" + pt.lat + "/" + pt.lon;
    return '<iframe loading="lazy" title="Map" ' +
           'src="https://www.openstreetmap.org/export/embed.html?bbox=' + encodeURIComponent(box) +
           '&amp;layer=mapnik&amp;marker=' + pt.lat + "," + pt.lon + '"></iframe>' +
           '<a class="maplink" href="' + esc(osm) + '" target="_blank" rel="noopener noreferrer">Open map \u2197</a>';
  }

  function searchLink(q) {
    return '<a class="maplink" href="https://www.openstreetmap.org/search?query=' +
           encodeURIComponent(q) + '" target="_blank" rel="noopener noreferrer">Find on map \u2197</a>';
  }

  /* Look the address up with Nominatim. Results are cached so a repeat visit
     costs nothing, and lookups are spaced out to stay inside their usage policy. */
  var GEO_KEY = "nbn-geocache-v2";   // bumped: v1 cached misses from the single-term search
  var geoCache = {};
  try { geoCache = JSON.parse(localStorage.getItem(GEO_KEY) || "{}") || {}; } catch (err) { geoCache = {}; }
  var geoQueue = Promise.resolve();

  function lookup(q) {
    var run = geoQueue.then(function () {
      return fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q), {
        headers: { Accept: "application/json" }
      }).then(function (r) {
        return r.ok ? r.json() : [];
      }).then(function (rows) {
        return rows && rows[0] ? { lat: +rows[0].lat, lon: +rows[0].lon } : null;
      }).catch(function () { return null; });
    });
    // One request per second, whatever the outcome of the last one.
    geoQueue = run.then(function () {
      return new Promise(function (done) { setTimeout(done, 1100); });
    });
    return run;
  }

  /* Venue names rarely resolve ("The Dog and Gun, Walton LE17 5RG" finds nothing),
     so the search is retried on progressively plainer forms of the address. */
  function geoTerms(q) {
    var out = [q];
    var parts = q.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    while (parts.length > 1) {
      parts = parts.slice(1);
      out.push(parts.join(", "));
    }
    var pc = /\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/i.exec(q);
    if (pc) out.push(pc[0] + ", UK");
    return out.filter(function (t, i) { return t && out.indexOf(t) === i; });
  }

  function geocode(q) {
    if (Object.prototype.hasOwnProperty.call(geoCache, q)) return Promise.resolve(geoCache[q]);
    var terms = geoTerms(q);

    function tryNext(i) {
      if (i >= terms.length) return Promise.resolve(null);
      return lookup(terms[i]).then(function (pt) { return pt || tryNext(i + 1); });
    }

    return tryNext(0).then(function (pt) {
      geoCache[q] = pt;
      try { localStorage.setItem(GEO_KEY, JSON.stringify(geoCache)); } catch (err) { /* blocked */ }
      return pt;
    });
  }

  /* Maps land after the popup is on screen, so each event gets an empty slot first. */
  function mapSlot(e) {
    if (!e.location && !e.geohash) return "";
    return '<div class="modal-map" id="map-' + esc(e.ev.id) + '"></div>';
  }

  function fillMaps(list) {
    list.forEach(function (e) {
      var slot = document.getElementById("map-" + e.ev.id);
      if (!slot) return;
      var fallback = e.geohash ? geohashDecode(e.geohash) : null;

      function show(pt) {
        // The popup may have been closed or replaced while we were waiting.
        if (document.getElementById("map-" + e.ev.id) !== slot) return;
        if (pt) slot.innerHTML = mapFrame(pt);
        else slot.innerHTML = e.location ? searchLink(e.location) : "";
      }

      if (!e.location) return show(fallback);
      slot.innerHTML = '<p class="modal-note">Finding the map\u2026</p>';
      geocode(e.location).then(function (pt) { show(pt || fallback); });
    });
  }

  /* ---- who is coming (NIP-52 kind 31925 RSVPs) ---- */
  var RSVP_KIND = 31925;
  var rsvpBy = {};      // "kind:pubkey:d" -> { pubkey: { status, at } }
  var rsvpAsked = {};

  function eventCoord(e) {
    return e.ev.kind + ":" + e.ev.pubkey + ":" + tagValue(e.ev, "d");
  }

  /* RSVPs come from anyone, so they are fetched per event rather than with the feed. */
  function loadRsvps(coord, onUpdate) {
    if (rsvpAsked[coord]) return;
    rsvpAsked[coord] = true;
    rsvpBy[coord] = rsvpBy[coord] || {};

    RELAYS.forEach(function (url) {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { return; }
      var timer = setTimeout(shut, TIMEOUT_MS);

      function shut() {
        clearTimeout(timer);
        try { ws.close(); } catch (e) { /* already closed */ }
      }

      ws.onopen = function () {
        ws.send(JSON.stringify(["REQ", "rsvp", { kinds: [RSVP_KIND], "#a": [coord], limit: 200 }]));
      };
      ws.onerror = shut;
      ws.onclose = function () { clearTimeout(timer); };
      ws.onmessage = function (msg) {
        var data;
        try { data = JSON.parse(msg.data); } catch (e) { return; }
        if (data[0] === "EOSE") return shut();
        if (data[0] !== "EVENT" || !data[2] || data[2].kind !== RSVP_KIND) return;
        var ev = data[2];
        // Only the latest reply from each person counts.
        var cur = rsvpBy[coord][ev.pubkey];
        if (cur && cur.at >= ev.created_at) return;
        rsvpBy[coord][ev.pubkey] = {
          at: ev.created_at,
          status: (tagValue(ev, "status") || "accepted").toLowerCase()
        };
        needName(ev.pubkey);
        onUpdate();
      };
    });
  }

  var RSVP_LABEL = { accepted: "Going", tentative: "Maybe", declined: "Not going" };

  function rsvpName(pk) {
    return personName(pk);
  }

  function rsvpHtml(coord) {
    var by = rsvpBy[coord] || {};
    var keys = Object.keys(by);
    if (!keys.length) return "";
    var groups = { accepted: [], tentative: [], declined: [] };
    keys.forEach(function (pk) {
      (groups[by[pk].status] || groups.accepted).push(rsvpName(pk));
    });

    var rows = "";
    ["accepted", "tentative", "declined"].forEach(function (k) {
      if (!groups[k].length) return;
      rows += '<p class="rsvp-row"><span class="rsvp-tag is-' + k + '">' + RSVP_LABEL[k] + ' ' +
              groups[k].length + '</span>' + esc(groups[k].sort().join(", ")) + '</p>';
    });
    return '<h4 class="rsvp-head">Replies</h4>' + rows;
  }

  function fillRsvps(list) {
    list.forEach(function (e) {
      var slot = document.getElementById("rsvp-" + e.ev.id);
      if (!slot) return;
      var coord = eventCoord(e);

      function draw() {
        // The popup may have been closed or replaced while we were waiting.
        if (document.getElementById("rsvp-" + e.ev.id) !== slot) return;
        slot.innerHTML = rsvpHtml(coord);
      }

      draw();
      nameHooks.push(draw);
      loadRsvps(coord, draw);
    });
  }

  /* ---- event popup ---- */
  function eventDetail(e) {
    var d = new Date(e.start * 1000);
    var img = e.image || imagesOf(e.ev)[0] || "";
    var when = e.allDay
      ? fmtDate(e.start)
      : fmtDate(e.start) + " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (e.end && !e.allDay) {
      when += "–" + new Date(e.end * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    }

    var html = '<article class="modal-event">';
    html += '<h3 id="modal-title" class="modal-title">' + esc(e.title) + '</h3>';
    html += '<p class="modal-when">' + esc(when) + (isPast(e) ? ' · <em>past</em>' : '') + '</p>';
    if (e.location) html += '<p class="modal-where">' + esc(e.location) + '</p>';
    if (img) html += '<img class="modal-img" src="' + esc(img) + '" alt="">';
    if (e.summary) html += '<div class="modal-summary">' + renderContent(e.summary) + '</div>';
    html += mapSlot(e);
    html += '<div class="rsvp" id="rsvp-' + esc(e.ev.id) + '"></div>';
    return html + '</article>';
  }

  function openDay(key) {
    reopenModal = function () { openDay(key); };
    var parts = key.split("-");
    var y = +parts[0], mo = +parts[1], da = +parts[2];
    var list = calendarEvents().all.filter(function (e) {
      var d = new Date(e.start * 1000);
      return d.getFullYear() === y && d.getMonth() === mo && d.getDate() === da;
    });
    if (!list.length) return;

    var head = list.length > 1
      ? '<p class="modal-count">' + list.length + ' events on ' +
        new Date(y, mo, da).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + '</p>'
      : "";
    var days = keysIn("[data-day]");
    setModalNav(days, days.indexOf(key), openDay);
    showModal(head + list.map(eventDetail).join(""));
    fillMaps(list);
    fillRsvps(list);
  }

  /* The arrows walk whatever is currently on the page, in the order it is shown. */
  var modalNav = null;

  function keysIn(sel) {
    return Array.prototype.map.call(document.querySelectorAll("#content " + sel), function (el) {
      return el.dataset.note || el.dataset.day || el.dataset.event;
    });
  }

  function setModalNav(list, i, open) {
    modalNav = list.length > 1 && i !== -1 ? { list: list, i: i, open: open } : null;
    $("modal-prev").hidden = $("modal-next").hidden = !modalNav;
  }

  function modalStep(d) {
    if (!modalNav) return;
    var n = modalNav.list.length;
    modalNav.open(modalNav.list[(modalNav.i + d + n) % n]);
    $("modal-panel").scrollTop = 0;
  }

  var reopenModal = null;   // redraws the popup in place as late data arrives

  function refreshModal() {
    if (!reopenModal || $("modal").hidden) return;
    var top = $("modal-panel").scrollTop;
    reopenModal();
    $("modal-panel").scrollTop = top;
  }

  function showModal(html) {
    $("modal-body").innerHTML = html;
    $("modal").hidden = false;
    document.body.classList.add("is-locked");
  }

  function openEvent(id) {
    reopenModal = function () { openEvent(id); };
    var hit = null;
    calendarEvents().all.forEach(function (e) { if (e.ev.id === id) hit = e; });
    if (!hit) return;
    var list = keysIn("[data-event]");
    setModalNav(list, list.indexOf(id), openEvent);
    showModal(eventDetail(hit));
    fillMaps([hit]);
    fillRsvps([hit]);
  }

  function openNote(id) {
    reopenModal = function () { openNote(id); };
    var ev = events.get(id);
    if (!ev) return;
    var list = keysIn("[data-note]");
    setModalNav(list, list.indexOf(id), openNote);
    showModal(noteCard(ev, { single: true }));
  }

  function closeModal() {
    modalNav = null;
    reopenModal = null;
    nameHooks.length = 0;
    $("modal").hidden = true;
    $("modal-body").innerHTML = "";
    document.body.classList.remove("is-locked");
  }

  function pageNum(s) {
    return Math.max(1, parseInt(s, 10) || 1);
  }

  function pager(base, page, pages) {
    if (pages < 2) return "";
    var html = '<nav class="pager" aria-label="Pages">';
    html += page > 1
      ? '<a class="pager-btn" href="' + base + (page - 1) + '" rel="prev">← Newer</a>'
      : '<span class="pager-btn is-off">← Newer</span>';
    html += '<span class="pager-info">Page ' + page + ' of ' + pages + '</span>';
    html += page < pages
      ? '<a class="pager-btn" href="' + base + (page + 1) + '" rel="next">Older →</a>'
      : '<span class="pager-btn is-off">Older →</span>';
    return html + '</nav>';
  }

  /* Every listing renders the same way: a grid of cards plus a pager. */
  function pagedList(items, base, want, emptyMsg, cls, card) {
    if (!items.length) return '<p class="empty">' + emptyMsg + '</p>';
    var pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
    // Content keeps arriving, so a bookmarked page number can outrun the list.
    var page = Math.min(want || 1, pages);
    var slice = items.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    return '<div class="' + cls + '">' + slice.map(card).join("") + '</div>' + pager(base, page, pages);
  }

  function postList(items, base, want, emptyMsg) {
    return pagedList(items, base, want, emptyMsg, "feed-grid", function (e) { return noteCard(e); });
  }


  // ---------- long-form articles (NIP-23, kind 30023) ----------
  function articles() {
    var out = [];
    events.forEach(function (ev) {
      if (ev.kind !== 30023) return;
      var at = parseInt(tagValue(ev, "published_at"), 10) || ev.created_at;
      out.push({
        ev: ev, at: at,
        title: tagValue(ev, "title") || "Untitled",
        summary: tagValue(ev, "summary"),
        image: tagValue(ev, "image") || imagesOf(ev)[0] || ""
      });
    });
    return out.sort(function (a, b) { return b.at - a.at; });
  }

  /* A small Markdown renderer — enough for what long-form posts actually use.
     Everything runs through the shared escaping, so no author markup reaches
     the page; finished fragments are parked under a marker while it works. */
  var MARK = "\uE000";   // a private-use marker, never present in real text

  function mdInline(text) {
    var held = [];
    function hold(html) { return MARK + (held.push(html) - 1) + MARK; }

    var src = String(text);
    src = src.replace(/`([^`]+)`/g, function (_, code) { return hold("<code>" + esc(code) + "</code>"); });
    src = src.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (_, alt, url) {
      return /^https?:\/\//i.test(url)
        ? hold('<img src="' + esc(url) + '" alt="' + esc(alt) + '" loading="lazy">')
        : "";
    });
    src = src.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, function (whole, label, url) {
      if (!/^(https?:\/\/|#|mailto:)/i.test(url)) return whole;
      return hold('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>');
    });

    // Bare URLs, mentions and hashtags all come from the shared renderer.
    var out = renderContent(src);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
    return out.replace(new RegExp(MARK + "(\\d+)" + MARK, "g"), function (_, i) { return held[+i]; });
  }

  function renderMarkdown(text) {
    var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    var html = "", para = [], list = null, fence = null;

    function flushPara() {
      if (!para.length) return;
      html += "<p>" + mdInline(para.join("\n")) + "</p>";
      para = [];
    }
    function flushList() {
      if (!list) return;
      html += "<" + list.tag + ">" + list.items.map(function (t) {
        return "<li>" + mdInline(t) + "</li>";
      }).join("") + "</" + list.tag + ">";
      list = null;
    }
    function flush() { flushPara(); flushList(); }

    lines.forEach(function (line) {
      if (fence !== null) {
        if (/^\s*```/.test(line)) {
          html += "<pre><code>" + esc(fence.join("\n")) + "</code></pre>";
          fence = null;
        } else fence.push(line);
        return;
      }
      if (/^\s*```/.test(line)) { flush(); fence = []; return; }
      if (!line.trim()) { flush(); return; }

      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        var n = Math.min(h[1].length + 1, 6);   // the page title is the h1
        html += "<h" + n + ">" + mdInline(h[2]) + "</h" + n + ">";
        return;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html += "<hr>"; return; }

      var q = /^\s*>\s?(.*)$/.exec(line);
      if (q) { flush(); html += "<blockquote>" + mdInline(q[1]) + "</blockquote>"; return; }

      var b = /^\s*[-*+]\s+(.*)$/.exec(line);
      var o = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (b || o) {
        var tag = b ? "ul" : "ol";
        flushPara();
        if (list && list.tag !== tag) flushList();
        list = list || { tag: tag, items: [] };
        list.items.push((b || o)[1]);
        return;
      }

      flushList();
      para.push(line);
    });

    if (fence !== null) html += "<pre><code>" + esc(fence.join("\n")) + "</code></pre>";
    flush();
    return html;
  }

  function articleCard(a) {
    var html = '<a class="article" href="#/article/' + esc(a.ev.id) + '">';
    if (a.image) html += '<img class="article-img" src="' + esc(a.image) + '" alt="" loading="lazy">';
    html += '<div class="article-text">';
    html += '<time class="article-date" datetime="' + new Date(a.at * 1000).toISOString() + '">' +
            fmtDate(a.at) + '</time>';
    html += '<h3 class="article-title">' + esc(a.title) + '</h3>';
    if (a.summary) html += '<p class="article-summary">' + esc(a.summary) + '</p>';
    return html + '</div></a>';
  }

  function articlePage(id) {
    var hit = null;
    articles().forEach(function (a) { if (a.ev.id === id) hit = a; });
    if (!hit) {
      return '<a class="backlink" href="#/articles">← All articles</a>' +
             '<p class="empty">That article has not loaded yet. It may still be arriving from the relays.</p>';
    }
    var tags = hashtagsOf(hit.ev);
    var html = '<a class="backlink" href="#/articles">← All articles</a>';
    html += '<article class="longform">';
    html += '<h1 class="longform-title">' + esc(hit.title) + '</h1>';
    html += '<p class="longform-date">' + esc(fmtDate(hit.at)) + '</p>';
    if (hit.summary) html += '<p class="longform-summary">' + esc(hit.summary) + '</p>';
    if (hit.image) html += '<img class="longform-img" src="' + esc(hit.image) + '" alt="">';
    html += '<div class="longform-body">' + renderMarkdown(hit.ev.content) + '</div>';
    if (tags.length) {
      html += '<div class="note-foot">' + tags.map(function (t) {
        return '<a class="hashtag" href="#/tag/' + encodeURIComponent(t) + '">#' + esc(t) + '</a>';
      }).join("") + '</div>';
    }
    return html + '</article>';
  }

  // ---------- routing ----------
  function route() {
    var h = (location.hash || "#/").replace(/^#/, "");
    var parts = h.split("/").filter(Boolean);
    if (parts[0] === "tag" && parts[1]) {
      return { name: "tag", tag: decodeURIComponent(parts[1]), page: pageNum(parts[2]) };
    }
    if (parts[0] === "note" && parts[1]) return { name: "note", id: parts[1] };
    if (parts[0] === "article" && parts[1]) return { name: "article", id: parts[1] };
    if (parts[0] === "articles") return { name: "articles", page: pageNum(parts[1]) };
    if (parts[0] === "mentions") return { name: "mentions", page: pageNum(parts[1]) };
    if (parts[0] === "page" && parts[1]) return { name: "home", page: pageNum(parts[1]) };
    if (parts[0] === "gallery") return { name: "gallery", page: pageNum(parts[1]) };
    if (parts[0] === "calendar") return { name: "calendar", page: pageNum(parts[1]) };
    if (parts[0] === "tags") return { name: "tags" };
    if (parts[0] === "about") return { name: "about" };
    return { name: "home", page: 1 };
  }

  /* Which setting governs each route; the feed is never switchable. */
  var PAGE_OF = { tags: "topics", tag: "topics", gallery: "gallery", calendar: "calendar",
                  articles: "articles", article: "articles", mentions: "mentions",
                  about: "about" };

  function activeRoute() {
    var r = route();
    var key = PAGE_OF[r.name];
    return key && !PAGES[key] ? { name: "home", page: 1 } : r;
  }

  var TABS = [
    { key: "", href: "#/", label: "Posts", route: "home" },
    { key: "topics", href: "#/tags", label: "Topics", route: "tags" },
    { key: "gallery", href: "#/gallery", label: "Gallery", route: "gallery" },
    { key: "calendar", href: "#/calendar", label: "Events", route: "calendar" },
    { key: "articles", href: "#/articles", label: "Articles", route: "articles" },
    { key: "mentions", href: "#/mentions", label: "Mentions", route: "mentions" },
    { key: "about", href: "#/about", label: "About", route: "about" }
  ];

  /* Falls back to the profile picture, which arrives after the relays reply. */
  function setFavicon() {
    var href = FAVICON || (profile && profile.picture) || "";
    if (href) $("favicon").href = href;
  }

  function buildTabs() {
    $("tabs").innerHTML = TABS.filter(function (t) { return !t.key || PAGES[t.key]; })
      .map(function (t) {
        return '<a href="' + t.href + '" class="tab" data-route="' + t.route + '">' + t.label + '</a>';
      }).join("");
  }

  function setActiveTab(name) {
    var map = { home: "home", tag: "tags", tags: "tags", gallery: "gallery",
                calendar: "calendar", articles: "articles", article: "articles",
                mentions: "mentions", about: "about", note: "home" };
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (a) {
      a.classList.toggle("is-active", a.dataset.route === map[name]);
    });
  }

  function render() {
    renderQueued = false;
    var r = activeRoute();
    var content = $("content");
    var list = notes();
    setActiveTab(r.name);

    // Masthead from the live profile event
    if (profile) {
      if (profile.display_name || profile.name) $("site-title").textContent = profile.display_name || profile.name;
      if (profile.about) $("site-about").textContent = profile.about;
      if (profile.picture) { $("avatar").src = profile.picture; $("avatar").alt = profile.display_name || "avatar"; }
      if (profile.banner) $("banner").style.backgroundImage = "url('" + profile.banner.replace(/'/g, "%27") + "')";
      if (profile.nip05) { var n = $("nip05"); n.textContent = "✓ " + profile.nip05; n.hidden = false; }
    }
    setFavicon();
    var npub = bech32Encode("npub", PUBKEY);
    var nl = $("npub-link");
    nl.textContent = npub.slice(0, 14) + "…" + npub.slice(-6);
    nl.href = "https://njump.me/" + npub;
    nl.target = "_blank"; nl.rel = "noopener noreferrer";

    var html = "";
    if (r.name === "note") {
      var found = null;
      events.forEach(function (e) { if (e.kind === 1 && bech32Encode("note", e.id) === r.id) found = e; });
      html += '<a class="backlink" href="#/">← All posts</a>';
      html += found ? noteCard(found, { single: true })
                    : '<p class="empty">That post hasn\'t loaded yet. It may still be arriving from the relays.</p>';
    } else if (r.name === "article") {
      html += articlePage(r.id);
    } else if (r.name === "articles") {
      var arts = articles();
      html += '<h2 class="section-title">Articles <span class="count">(' + arts.length + ')</span></h2>';
      html += pagedList(arts, "#/articles/", r.page,
                        "No articles published yet.", "article-list", articleCard);
    } else if (r.name === "mentions") {
      var said = mentions();
      html += '<h2 class="section-title">Mentions <span class="count">(' + said.length + ')</span></h2>';
      html += pagedList(said, "#/mentions/", r.page,
                        "Nobody has mentioned this account yet.", "feed-grid", function (e) {
                          return noteCard(e, { author: true });
                        });
    } else if (r.name === "tags") {
      var counts = {};
      list.forEach(function (e) { hashtagsOf(e).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
      var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
      html += '<h2 class="section-title">Topics</h2>';
      html += keys.length ? '<div class="tag-cloud">' + keys.map(function (t) {
        return '<a class="tag-chip" href="#/tag/' + encodeURIComponent(t) + '">#' + esc(t) +
               '<span class="count">' + counts[t] + '</span></a>';
      }).join("") + '</div>' : '<p class="empty">No topics found yet.</p>';
    } else if (r.name === "tag") {
      var want = r.tag.toLowerCase();
      var hits = list.filter(function (e) { return hashtagsOf(e).indexOf(want) !== -1; });
      html += '<a class="backlink" href="#/tags">← All topics</a>';
      html += '<h2 class="section-title">Posts tagged #' + esc(r.tag) + ' <span class="count">(' + hits.length + ')</span></h2>';
      html += postList(hits, "#/tag/" + encodeURIComponent(r.tag) + "/", r.page,
                       "Nothing tagged #" + esc(r.tag) + ".");
    } else if (r.name === "gallery") {
      var shots = galleryItems();
      html += '<h2 class="section-title">Gallery <span class="count">(' + shots.length + ')</span></h2>';
      html += pagedList(shots, "#/gallery/", r.page,
                        "No images in the posts yet.", "gallery-grid", galleryTile);
    } else if (r.name === "calendar") {
      var cal = calendarEvents();
      html += '<h2 class="section-title">Events <span class="count">(' +
              cal.upcoming.length + ' upcoming)</span></h2>';
      html += monthGrid(cal);
      if (!cal.all.length) {
        html += '<p class="empty">No calendar events published yet.</p>';
      } else {
        // Everything still to come is listed in full; only the past is paged.
        html += cal.upcoming.length
          ? '<div class="feed-grid event-grid">' + cal.upcoming.map(eventCard).join("") + '</div>'
          : '<p class="empty">Nothing coming up just now.</p>';
        if (cal.past.length) {
          html += '<h2 class="section-title">Past events <span class="count">(' + cal.past.length + ')</span></h2>';
          html += pagedList(cal.past, "#/calendar/", r.page, "", "feed-grid event-grid", eventCard);
        }
      }
    } else if (r.name === "about") {
      html += '<h2 class="section-title">About</h2><div class="about-card">';
      html += '<p>' + esc((profile && profile.about) || "Grassroots Bitcoin community in Northamptonshire, England.") + '</p><dl>';
      if (profile && profile.nip05) html += '<dt>Nostr address</dt><dd>' + esc(profile.nip05) + '</dd>';
      if (profile && profile.lud16) html += '<dt>Lightning</dt><dd>' + esc(profile.lud16) + '</dd>';
      html += '<dt>Public key</dt><dd>' + esc(npub) + '</dd>';

      var email = String(CONTACT.email || "").trim();
      if (email) html += '<dt>Email</dt><dd><a href="mailto:' + esc(email) + '">' + esc(email) + '</a></dd>';

      var tg = String(CONTACT.telegram || "").trim();
      if (tg) {
        // Accept a full URL, an @handle or a bare handle.
        var tgUrl = /^https?:\/\//i.test(tg) ? tg : "https://t.me/" + tg.replace(/^@/, "");
        html += '<dt>Telegram</dt><dd><a href="' + esc(tgUrl) + '" target="_blank" rel="noopener noreferrer">' +
                esc(tg) + '</a></dd>';
      }

      LINKS.forEach(function (l) {
        html += '<dt>' + esc(l.label) + '</dt><dd><a href="' + esc(l.url) +
                '" target="_blank" rel="noopener noreferrer">' + esc(l.url) + '</a></dd>';
      });

      html += '</dl></div>';
    } else {
      var roots = list.filter(function (e) { return !isReply(e); });
      var shown = roots.length ? roots : list;
      html += postList(shown, "#/page/", r.page, "No posts loaded yet.");
    }
    // Anything laid out as a grid of cards gets the wide column.
    var WIDE = ["home", "tag", "gallery", "calendar", "mentions"];
    $("main").classList.toggle("is-wide", WIDE.indexOf(r.name) !== -1);
    content.innerHTML = html;
    trimCards();

    // Only jump to the top on a real navigation, not when relays deliver more posts.
    var key = r.name + ":" + (r.page || "") + (r.tag || "") + (r.id || "");
    if (key !== lastViewKey) { lastViewKey = key; window.scrollTo(0, 0); }

  }

  /* Cards are a fixed height, so a body that overflows is cut back to a whole
     number of lines — never through the middle of one. */
  function trimCards() {
    var bodies = document.querySelectorAll(".feed-grid .note-body");
    Array.prototype.forEach.call(bodies, function (el) {
      el.style.maxHeight = "";
      var lh = parseFloat(window.getComputedStyle(el).lineHeight);
      if (!lh || !el.clientHeight) return;
      if (el.scrollHeight <= el.clientHeight + 1) return;
      var lines = Math.max(1, Math.floor(el.clientHeight / lh));
      el.style.maxHeight = (lines * lh) + "px";
    });
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  // ---------- relay connections ----------
  function connect(url) {
    return new Promise(function (resolve) {
      var ws, count = 0, settled = false;
      function finish(state) {
        if (settled) return;
        settled = true;
        relayStats[url] = state === "ok" ? count : state;
        clearTimeout(timer);
        try { ws.close(); } catch (e) { /* already closed */ }
        resolve();
      }
      var timer = setTimeout(function () { finish("ok"); }, TIMEOUT_MS);
      try { ws = new WebSocket(url); } catch (e) { return finish("blocked"); }

      // Mentions are a second subscription: they are by other people, not this account.
      var subs = PAGES.mentions ? 2 : 1;

      ws.onopen = function () {
        ws.send(JSON.stringify(["REQ", "nbn", { authors: [PUBKEY], kinds: KINDS, limit: 500 }]));
        if (PAGES.mentions) {
          ws.send(JSON.stringify(["REQ", "mentions", { "#p": [PUBKEY], kinds: [1], limit: 200 }]));
        }
      };
      ws.onerror = function () { finish("offline"); };
      ws.onclose = function () { finish("ok"); };
      ws.onmessage = function (msg) {
        var data;
        try { data = JSON.parse(msg.data); } catch (e) { return; }
        if (data[0] === "EVENT" && data[2] && data[2].id) {
          if (!events.has(data[2].id)) {
            events.set(data[2].id, data[2]);
            count++;
            if (data[2].kind === 0) absorbProfile();
            queueRender();
          }
        } else if (data[0] === "EOSE") {
          if (--subs <= 0) finish("ok");
        }
      };
    });
  }

  function summarise() {
    var ok = 0, total = 0;
    Object.keys(relayStats).forEach(function (r) {
      total++;
      if (typeof relayStats[r] === "number") ok++;
    });
    $("relaystat").textContent = notes().length + " posts · " + ok + "/" + total + " relays responded";
  }

  // ---------- boot ----------
  if (KEY_ERROR) {
    $("content").innerHTML =
      '<p class="empty">Configuration problem in <code>assets/config.js</code>: ' +
      esc(KEY_ERROR) + '.</p>';
    return;
  }

  $("content").addEventListener("click", function (ev) {
    var nav = ev.target.closest("[data-cal]");
    if (nav) {
      ev.preventDefault();
      var d = new Date(MONTH_MS);
      MONTH_MS = new Date(d.getFullYear(), d.getMonth() + (nav.dataset.cal === "next" ? 1 : -1), 1).getTime();
      return render();
    }
    var day = ev.target.closest("[data-day]");
    if (day) { ev.preventDefault(); openDay(day.dataset.day); }

    // Links, media controls and text selection keep their own behaviour, unless
    // the card itself is the link.
    var card = ev.target.closest("[data-note], [data-event]");
    var inner = ev.target.closest("a, button, video, audio, iframe");
    if (card && (!inner || inner === card) && !hasSelection()) {
      ev.preventDefault();
      if (card.dataset.note) openNote(card.dataset.note);
      else openEvent(card.dataset.event);
    }
  });

  $("content").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var card = ev.target.closest("[data-note], [data-event]");
    if (card && ev.target === card) {
      ev.preventDefault();
      if (card.dataset.note) openNote(card.dataset.note);
      else openEvent(card.dataset.event);
    }
  });

  $("modal").addEventListener("click", function (ev) {
    var nav = ev.target.closest("[data-nav]");
    if (nav) return modalStep(+nav.dataset.nav);
    if (ev.target.closest("[data-close]")) closeModal();
  });
  document.addEventListener("keydown", function (ev) {
    if ($("modal").hidden) return;
    if (ev.key === "Escape") closeModal();
    else if (ev.key === "ArrowLeft") modalStep(-1);
    else if (ev.key === "ArrowRight") modalStep(1);
  });

  setFavicon();
  buildTabs();
  window.addEventListener("hashchange", render);

  loadCache();
  render();

  Promise.all(RELAYS.map(connect)).then(function () {
    absorbProfile();
    saveCache();
    render();
    summarise();
    if (!notes().length) {
      $("content").innerHTML =
        '<p class="empty">Could not reach any relay. This is usually a temporary network problem — please refresh.</p>';
    }
  });
})();
