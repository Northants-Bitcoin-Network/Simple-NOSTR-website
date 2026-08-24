/* Site settings. Edit this file — nothing else needs touching. */
var SITE_CONFIG = {

  /* Whose posts this site shows.
     Paste an npub1… key here (a bare 64-character hex pubkey also works). */
  npub: "npub1d6cnmzg9m4kpfxxnzvcgljg4jwk09tu2xet3e72yx6ddgrkgmm7sj4jpwn",

  /* How many posts appear on each page of the feed. */
  perPage: 20,

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
