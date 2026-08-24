A simple website that displays your nostr posts


## How this works

There is **no database and no backend**. The site is plain HTML, CSS and JavaScript.
When someone opens the page it connects directly to public Nostr relays and reads
the posts published by your Nostr account.

**To publish a new post, just post on Nostr as usual.** It appears on the website
automatically — there is nothing to rebuild, upload or deploy.

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

