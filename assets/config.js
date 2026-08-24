/* Site settings. Edit this file — nothing else needs touching. */
var SITE_CONFIG = {

  /* Whose posts this site shows.
     Paste an npub1… key here (a bare 64-character hex pubkey also works). */
  npub: "npub1d6cnmzg9m4kpfxxnzvcgljg4jwk09tu2xet3e72yx6ddgrkgmm7sj4jpwn",

  /* Browser tab icon. A URL, a local file like "assets/icon.png", or leave it
     empty ("") to use the account's Nostr profile picture. */
  favicon: "https://cdn.nostr.build/i/95ddaad6c4b9c39f65af30c407eda40abaa10de13ed6c998583e56423dbe97eb.jpg",

  /* How many posts appear on each page of the feed. */
  perPage: 20,

  /* Which pages appear in the navigation. Set one to false to hide both its
     tab and its page; links to a hidden page fall back to the feed.
       topics   - hashtags found in the posts, and the posts under each
       gallery  - every image from the posts, as a grid
       calendar - calendar events published by this account (NIP-52) */
  pages: {
    topics: true,
    gallery: true,
    calendar: true,
    about: true
  },

  /* Relays to read from. The site queries all of them at once and merges the
     results, so extras only add redundancy — if one is down or slow, the rest
     still deliver. nos.lol currently holds the fullest archive. */
  relays: [
    "wss://nos.lol",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://relay.nostr.band",
    "wss://nostr.wine",
    "wss://purplepag.es",
    "wss://relay.snort.social",
    "wss://nostr.bitcoiner.social",
    "wss://relayable.org"
  ]

};
