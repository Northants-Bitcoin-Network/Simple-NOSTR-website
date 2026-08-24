A simple website that displays your nostr posts

## How this works

There is **no database and no backend**. The site is plain HTML, CSS and JavaScript.
When someone opens the page it connects directly to public Nostr relays and reads
the posts published by your Nostr account.

**To publish a new post, just post on Nostr as usual.** It appears on the website
automatically — there is nothing to rebuild, upload or deploy.

- Profile, name, picture, banner and bio are all read live from the Nostr profile,
  so editing your profile in any Nostr client updates the website too.
- Posts are cached in the browser, so returning visitors see the site immediately
  while fresh posts arrive in the background.

## Settings

Everything you are likely to change lives in **`assets/config.js`**. Edit that one
file — nothing else needs touching.

```js
var SITE_CONFIG = {
  npub: "npub1…",     // whose posts the site shows
  perPage: 20,        // posts per page
  pages: { topics: true, gallery: true, calendar: true, articles: true,
           mentions: true, about: true },
  relays: [ "wss://nos.lol", … ]
};
```

| Setting | What it does |
|---|---|
| `npub` | The account the site displays. Paste an `npub1…` key (a bare 64-character hex pubkey also works). |
| `perPage` | How many posts, images or events appear on each page. |
| `pages` | Turns each optional page on or off — see below. |
| `relays` | Which relays to read from. All are queried at once and the results merged, so extra relays only add resilience when one is down. |

If the `npub` is missing or malformed, or the relay list is empty, the site says so
on the page instead of loading blank.

## Pages

The feed of posts is always shown. The rest are optional: set one to `false` in
`pages` and both its tab and its page disappear, with any link to it falling back
to the feed.

| Page | Shows |
|---|---|
| Posts | The feed — three posts across, paginated. Always on. |
| `topics` | Every hashtag found in the posts, and the posts filed under each one. |
| `gallery` | Every image from the posts as a grid, each linking back to its post. |
| `calendar` | Calendar events published by the account ([NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md)), upcoming first, past ones dimmed. |
| `articles` | Long-form articles published by the account ([NIP-23](https://github.com/nostr-protocol/nips/blob/master/23.md)), rendered from Markdown. |
| `mentions` | Posts by other people that tag this account, newest first. |
| `about` | Profile details, Nostr address, Lightning address and public key. |

Turning `calendar`, `articles` or `mentions` off also stops the site asking relays
for that data at all.

Every listing is paginated — the feed, the posts under a topic, the gallery and the
events — and page numbers live in the address (`#/page/2`, `#/tag/bitcoin/2`,
`#/gallery/3`, `#/calendar/2`, `#/articles/2`, `#/mentions/2`), so any page can be
linked or
bookmarked. Individual posts and articles have their own addresses too
(`#/note/note1…`, `#/article/<id>`).

## Files

| File | Purpose |
|---|---|
| `index.html` | The page shell |
| `assets/config.js` | **Your settings** — npub, pages, relays |
| `assets/app.js` | Connects to relays, fetches posts, renders the page |
| `assets/style.css` | Styling |
| `manifest.webmanifest` | Makes the site installable on phones |
| `.well-known/nostr.json` | NIP-05 verification (used if a custom domain is added) |
| `.nojekyll` | Stops GitHub hiding the `.well-known` folder |
