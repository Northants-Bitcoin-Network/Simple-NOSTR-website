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

  var PER_PAGE = Math.max(1, parseInt(CFG.perPage, 10) || 20);

  /* Optional pages, all on unless config.js says otherwise. */
  var PAGES = {};
  ["topics", "gallery", "calendar", "about"].forEach(function (k) {
    var v = (CFG.pages || {})[k];
    PAGES[k] = v === undefined ? true : !!v;
  });

  /* Calendar events are only worth asking the relays for if the page is on. */
  var KINDS = PAGES.calendar ? [0, 1, 31922, 31923] : [0, 1];
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

  function bech32Decode(str) {
    var s = String(str).trim().replace(/^nostr:/, "");
    if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();

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
    if (hrp !== "npub") throw new Error("expected an npub, got '" + hrp + "'");

    var bytes = convertBits(data.slice(0, -6), 5, 8, false);
    if (bytes.length !== 32) throw new Error("wrong key length");
    var hex = "";
    for (i = 0; i < bytes.length; ++i) hex += ("0" + bytes[i].toString(16)).slice(-2);
    return hex;
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
    events.forEach(function (e) { if (e.kind === 1) out.push(e); });
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

  function renderContent(text) {
    var src = String(text || "");
    var out = "", last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(src)) !== null) {
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
        out += '<a class="mention" href="https://njump.me/' + esc(id) +
               '" target="_blank" rel="noopener noreferrer">' + esc(id.slice(0, 12)) + '…</a>';
      } else if (m[4]) {
        var tag = m[4];
        out += esc(m[3]) + '<a class="hashtag" href="#/tag/' + encodeURIComponent(tag.toLowerCase()) +
               '">#' + esc(tag) + '</a>';
      }
    }
    out += esc(src.slice(last));
    return out;
  }

  function noteCard(ev, opts) {
    opts = opts || {};
    var nid = bech32Encode("note", ev.id);
    var tags = hashtagsOf(ev);
    var html = '<article class="note">';
    html += '<div class="note-head">';
    html += '<time class="note-date" datetime="' + new Date(ev.created_at * 1000).toISOString() + '">' +
            fmtDate(ev.created_at) + ' · ' + relTime(ev.created_at) + '</time>';
    if (isReply(ev)) html += '<span class="badge">Reply</span>';
    html += '</div>';
    html += '<div class="note-body">' + renderContent(ev.content) + '</div>';
    html += '<div class="note-foot">';
    if (!opts.single) html += '<a class="permalink" href="#/note/' + nid + '">Permalink</a>';
    html += '<a class="permalink" href="https://njump.me/' + nid +
            '" target="_blank" rel="noopener noreferrer">View on Nostr ↗</a>';
    tags.forEach(function (t) {
      html += '<a class="hashtag" href="#/tag/' + encodeURIComponent(t) + '">#' + esc(t) + '</a>';
    });
    html += '</div></article>';
    return html;
  }

  function galleryTile(item) {
    var nid = bech32Encode("note", item.ev.id);
    return '<a class="shot" href="#/note/' + nid + '" title="' + esc(fmtDate(item.ev.created_at)) + '">' +
           '<img src="' + esc(item.url) + '" alt="" loading="lazy">' +
           '<span class="shot-date">' + esc(fmtDate(item.ev.created_at)) + '</span></a>';
  }

  function eventCard(e) {
    var d = new Date(e.start * 1000);
    var nid = bech32Encode("note", e.ev.id);
    var when = e.allDay
      ? fmtDate(e.start)
      : fmtDate(e.start) + " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    var html = '<article class="event' + ((e.end || e.start) < Date.now() / 1000 ? " is-past" : "") + '">';
    html += '<div class="event-date"><span class="event-day">' + d.getDate() + '</span>' +
            '<span class="event-mon">' + d.toLocaleDateString("en-GB", { month: "short" }) + '</span></div>';
    html += '<div class="event-main"><h3 class="event-title">' + esc(e.title) + '</h3>';
    html += '<p class="event-when">' + esc(when) + '</p>';
    if (e.location) html += '<p class="event-where">' + esc(e.location) + '</p>';
    if (e.summary) html += '<div class="event-summary">' + renderContent(e.summary) + '</div>';
    html += '<div class="note-foot"><a class="permalink" href="https://njump.me/' + nid +
            '" target="_blank" rel="noopener noreferrer">View on Nostr ↗</a></div>';
    return html + '</div></article>';
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

  // ---------- routing ----------
  function route() {
    var h = (location.hash || "#/").replace(/^#/, "");
    var parts = h.split("/").filter(Boolean);
    if (parts[0] === "tag" && parts[1]) {
      return { name: "tag", tag: decodeURIComponent(parts[1]), page: pageNum(parts[2]) };
    }
    if (parts[0] === "note" && parts[1]) return { name: "note", id: parts[1] };
    if (parts[0] === "page" && parts[1]) return { name: "home", page: pageNum(parts[1]) };
    if (parts[0] === "gallery") return { name: "gallery", page: pageNum(parts[1]) };
    if (parts[0] === "calendar") return { name: "calendar", page: pageNum(parts[1]) };
    if (parts[0] === "tags") return { name: "tags" };
    if (parts[0] === "about") return { name: "about" };
    return { name: "home", page: 1 };
  }

  /* Which setting governs each route; the feed is never switchable. */
  var PAGE_OF = { tags: "topics", tag: "topics", gallery: "gallery", calendar: "calendar", about: "about" };

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
                calendar: "calendar", about: "about", note: "home" };
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
      html += pagedList(cal.all, "#/calendar/", r.page,
                        "No calendar events published yet.", "event-list", eventCard);
    } else if (r.name === "about") {
      html += '<h2 class="section-title">About</h2><div class="about-card">';
      html += '<p>' + esc((profile && profile.about) || "Grassroots Bitcoin community in Northamptonshire, England.") + '</p><dl>';
      if (profile && profile.nip05) html += '<dt>Nostr address</dt><dd>' + esc(profile.nip05) + '</dd>';
      if (profile && profile.lud16) html += '<dt>Lightning</dt><dd>' + esc(profile.lud16) + '</dd>';
      html += '<dt>Public key</dt><dd>' + esc(npub) + '</dd>';
      html += '<dt>Posts loaded</dt><dd>' + list.length + '</dd>';
      html += '</dl></div>';
    } else {
      var roots = list.filter(function (e) { return !isReply(e); });
      var shown = roots.length ? roots : list;
      html += postList(shown, "#/page/", r.page, "No posts loaded yet.");
    }
    $("main").classList.toggle("is-wide",
      r.name === "home" || r.name === "tag" || r.name === "gallery");
    content.innerHTML = html;

    // Only jump to the top on a real navigation, not when relays deliver more posts.
    var key = r.name + ":" + (r.page || "") + (r.tag || "") + (r.id || "");
    if (key !== lastViewKey) { lastViewKey = key; window.scrollTo(0, 0); }
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

      ws.onopen = function () {
        ws.send(JSON.stringify(["REQ", "nbn", { authors: [PUBKEY], kinds: KINDS, limit: 500 }]));
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
          finish("ok");
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
