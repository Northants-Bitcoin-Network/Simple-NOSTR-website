# Northants Bitcoin Network

The community website, hosted on GitHub Pages.

Grassroots #Bitcoin community in the Northamptonshire area of England. Est 729,964

## How this works

There is **no database and no backend**. The site is plain HTML, CSS and JavaScript.
When someone opens the page it connects directly to public Nostr relays and reads
the posts published by the community's Nostr account.

**To publish a new post, just post on Nostr as usual.** It appears on the website
automatically — there is nothing to rebuild, upload or deploy.

- Account: `npub1d6cnmzg9m4kpfxxnzvcgljg4jwk09tu2xet3e72yx6ddgrkgmm7sj4jpwn`
- Profile, name, picture, banner and bio are all read live from the Nostr profile,
  so editing your profile in any Nostr client updates the website too.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page shell |
| `assets/app.js` | Connects to relays, fetches posts, renders the page |
| `assets/style.css` | Styling |
| `manifest.webmanifest` | Makes the site installable on phones |
| `.well-known/nostr.json` | NIP-05 verification (used if a custom domain is added) |
| `404.html` | Redirects old `npub.pro` post links into the site |
| `.nojekyll` | Stops GitHub hiding the `.well-known` folder |

## Relays

Relays are listed at the top of `assets/app.js`. Add or remove them there.
The site merges results from all of them and removes duplicates, so it keeps
working even when some relays are down.

## Background

This replaces a site previously hosted by npub.pro, which has shut down — its
`npubpro.com` domain no longer resolves, taking the old site's stylesheet and
JavaScript with it. This version has no dependency on that service.
