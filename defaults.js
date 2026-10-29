const SCI_DEFAULTS = {
  enabled: true,
  filterFeed: true,
  mode: "hide",
  autoNotInterested: false,
  hideShorts: true,
  injectEnabled: true,
  infiniteFeed: true,   // endless feed for your topics (replaces the native home grid)
  sort: "relevance",    // "relevance" or "date" (newest first)
  maxCards: 12,
  keywords: [
    "space","nasa","spacex","esa","isro","jwst","james webb","hubble","telescope","galaxy","galaxies",
    "universe","cosmos","cosmic","black hole","planet","mars","moon","lunar","solar system","astronomy",
    "astrophysics","astronaut","rocket","satellite","orbit","exoplanet","nebula","supernova","big bang",
    "quantum","physics","chemistry","biology","neuroscience","science","scientist","experiment",
    "kurzgesagt","veritasium","pbs space time","scishow","vsauce","minutephysics","numberphile",
    "3blue1brown","anton petrov","scott manley","everyday astronaut","crash course"
  ],
  blockedChannels: [],
  // YouTube @handles (without the @). Edit freely in the popup.
  channels: [
    "NASA","kurzgesagt","veritasium","pbsspacetime","SciShow","minutephysics",
    "numberphile","3blue1brown","Vsauce","scottmanley","EverydayAstronaut","whatdamath","universetoday"
  ],
  // Topics: ANY search phrase. The infinite feed pages through results for these as you scroll.
  searches: ["space news this week","astrophysics explained","new science discovery","James Webb telescope"]
};
