import { NextResponse } from "next/server";

function normalizeTrendName(name: string) {
  return name
    .toLowerCase()
    .replace(/\b(the|a|an|for|and|with|plus)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/s$/, "");
}

function titleCase(term: string) {
  return term
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const TREND_PHRASE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "without",
  "kids",
  "kid",
  "adult",
  "adults",
  "girls",
  "boys",
  "men",
  "women",
  "ages",
  "age",
  "pack",
  "packs",
  "set",
  "sets",
  "pcs",
  "piece",
  "pieces",
  "bulk",
  "random",
  "colors",
  "color",
  "style",
  "styles",
  "party",
  "favor",
  "favors",
  "gift",
  "gifts",
  "birthday",
  "office",
  "desk",
  "home",
  "school",
  "cute",
  "fun",
  "new",
  "best",
  "hot",
  "toy",
  "toys",
  "item",
  "items",
  "stuffers",
  "basket",
]);

const TREND_PHRASE_WEAK_WORDS = new Set([
  "relief",
  "anxiety",
  "sensory",
  "fidget",
  "stress",
  "squeeze",
  "slow",
  "rising",
  "soft",
  "stretchy",
  "novelty",
  "play",
  "playing",
  "durable",
  "professional",
]);

function getTrendWords(title: string) {
  return normalizeTrendName(title)
    .split(" ")
    .filter((word) => {
      if (!word) return false;
      if (word.length <= 2) return false;
      if (/^\d+$/.test(word)) return false;
      if (TREND_PHRASE_STOP_WORDS.has(word)) return false;
      return true;
    });
}

function titleCasePhrase(phrase: string) {
  return phrase
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();

      if (lower === "tcg") return "TCG";
      if (lower === "usb") return "USB";
      if (lower === "magsafe") return "MagSafe";

      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function getPhraseScore(phrase: string, count: number) {
  const words = phrase.split(" ");
  const weakWordCount = words.filter((word) => TREND_PHRASE_WEAK_WORDS.has(word)).length;
  const weakPenalty = weakWordCount * 2;
  const lengthBonus = words.length;

  return count * 10 + lengthBonus - weakPenalty;
}

function getTitlePhrases(title: string) {
  const words = getTrendWords(title);
  const phrases: string[] = [];

  for (let size = 4; size >= 2; size--) {
    for (let index = 0; index <= words.length - size; index++) {
      const phraseWords = words.slice(index, index + size);
      const weakOnly = phraseWords.every((word) => TREND_PHRASE_WEAK_WORDS.has(word));

      if (weakOnly) continue;

      phrases.push(phraseWords.join(" "));
    }
  }

  return Array.from(new Set(phrases));
}

function buildAutomaticTrendPhraseCounts(titles: string[]) {
  const counts = new Map<string, number>();

  for (const title of titles) {
    for (const phrase of getTitlePhrases(title)) {
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }

  return counts;
}

function inferAutomaticTrendCategory(title: string, phraseCounts: Map<string, number>) {
  const titlePhrases = getTitlePhrases(title);

  const repeatedPhrases = titlePhrases
    .filter((phrase) => (phraseCounts.get(phrase) || 0) >= 2)
    .sort((a, b) => {
      const scoreA = getPhraseScore(a, phraseCounts.get(a) || 0);
      const scoreB = getPhraseScore(b, phraseCounts.get(b) || 0);

      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.length - a.length;
    });

  if (repeatedPhrases.length > 0) {
    return titleCasePhrase(repeatedPhrases[0]);
  }

  return inferTrendCategory(title);
}


function inferTrendCategory(term: string) {
  const normalized = normalizeTrendName(term);

 if (normalized.includes("needoh")) {
  return "NeeDoh";
}

if (normalized.includes("dumpling")) {
  return "Dumpling Squishy";
}

if (normalized.includes("axolotl")) {
  return "Axolotl Squishy";
}

if (normalized.includes("stress cube")) {
  return "Stress Cube";
}

if (normalized.includes("stress ball")) {
  return "Stress Balls";
}

if (normalized.includes("squishy")) {
  return "Squishy Toys";
}

  if (
    normalized.includes("labubu") ||
    normalized.includes("doll") ||
    normalized.includes("collectible")
  ) {
    return "Collectible Dolls";
  }

  if (normalized.includes("fidget") || normalized.includes("sensory")) {
    return "Fidget Toys";
  }

  if (normalized.includes("keychain")) {
    return "Collectible Keychains";
  }

  if (normalized.includes("candy") || normalized.includes("snack")) {
    return "Viral Candy";
  }

  if (normalized.includes("gadget")) {
    return "Gadgets";
  }

  return titleCase(term);
}

function buildGoogleTrendsCandidates(searchTerms: string[], category: string) {
  return searchTerms.slice(0, 10).map((term, index) => ({
    productName: titleCase(term),
    trendCategory: inferTrendCategory(term),
    category: category === "All" ? "General Merchandise" : category,
    sources: ["Google Trends"],
    mentions: 5000 + index * 1200,
    growthPercent: 25 + index * 12,
    score: 70 + index * 5,
    status: "Watching",
    notes: `Google Trends fallback candidate from search term: ${term}`,
  }));
}

function buildTikTokCandidates(category: string) {
  const tikTokProductsByCategory: Record<string, any[]> = {
    Toys: [
      {
        productName: "Squishies",
        trendCategory: "Squishies",
        mentions: 7,
        growthPercent: 95,
        score: 95,
        notes:
          "TikTok discovery trend from repeated squishy/squishies appearances.",
      },
      {
        productName: "Squishy Mystery Box",
        trendCategory: "Squishies",
        mentions: 4,
        growthPercent: 90,
        score: 90,
        notes:
          "TikTok discovery trend from Squishy Fun Box and mystery-style squishy videos.",
      },
      {
        productName: "Collectible Dolls",
        trendCategory: "Collectible Dolls",
        mentions: 3,
        growthPercent: 75,
        score: 75,
        notes: "TikTok discovery trend from repeated collectible doll appearances.",
      },
      {
        productName: "Cup Stacking Game",
        trendCategory: "Games",
        mentions: 1,
        growthPercent: 40,
        score: 40,
        notes: "TikTok discovery trend from one viral cup stacking video.",
      },
    ],
    Cellular: [
      {
        productName: "Magnetic Phone Grips",
        trendCategory: "Phone Accessories",
        mentions: 3,
        growthPercent: 70,
        score: 75,
        notes: "TikTok discovery placeholder for phone accessory trends.",
      },
      {
        productName: "Portable Power Banks",
        trendCategory: "Charging Accessories",
        mentions: 2,
        growthPercent: 65,
        score: 72,
        notes: "TikTok discovery placeholder for charging accessory trends.",
      },
    ],
    "Novelty Food": [
      {
        productName: "Freeze Dried Candy",
        trendCategory: "Viral Candy",
        mentions: 4,
        growthPercent: 85,
        score: 86,
        notes: "TikTok discovery placeholder for viral candy trends.",
      },
      {
        productName: "Sour Candy",
        trendCategory: "Viral Candy",
        mentions: 3,
        growthPercent: 70,
        score: 76,
        notes: "TikTok discovery placeholder for novelty candy trends.",
      },
    ],
    Sunglasses: [
      {
        productName: "Fashion Sunglasses",
        trendCategory: "Fashion Eyewear",
        mentions: 3,
        growthPercent: 65,
        score: 70,
        notes: "TikTok discovery placeholder for eyewear trends.",
      },
    ],
    Seasonal: [
      {
        productName: "Stocking Stuffers",
        trendCategory: "Holiday Gifts",
        mentions: 4,
        growthPercent: 80,
        score: 82,
        notes: "TikTok discovery placeholder for seasonal gift trends.",
      },
    ],
    "America 250": [
      {
        productName: "Red White Blue Party Items",
        trendCategory: "Patriotic Merchandise",
        mentions: 3,
        growthPercent: 70,
        score: 74,
        notes: "TikTok discovery placeholder for America 250 merchandise.",
      },
    ],
    "General Merchandise": [
      {
        productName: "Car Gadgets",
        trendCategory: "Gadgets",
        mentions: 4,
        growthPercent: 80,
        score: 82,
        notes: "TikTok discovery placeholder for general merchandise trends.",
      },
      {
        productName: "Desk Gadgets",
        trendCategory: "Gadgets",
        mentions: 3,
        growthPercent: 70,
        score: 76,
        notes: "TikTok discovery placeholder for desk gadget trends.",
      },
    ],
  };

  const products = tikTokProductsByCategory[category] || [];

  return products.map((item) => ({
    productName: item.productName,
    trendCategory: item.trendCategory,
    category: category === "All" ? "General Merchandise" : category,
    sources: ["TikTok"],
    mentions: item.mentions,
    growthPercent: item.growthPercent,
    score: item.score,
    status: "Watching",
    notes: item.notes,
  }));
}

function cleanAmazonTitle(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(",")[0]
    .split(" - ")[0]
    .trim();
}

async function fetchAmazonNewReleaseTitles(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const html = await response.text();

  console.log("Amazon New Releases URL:", url);
  console.log("Amazon New Releases HTML length:", html.length);

  const matches = [
    ...html.matchAll(
      /<div[^>]*class="[^"]*(?:_cDEzb_p13n-sc-css-line-clamp|p13n-sc-truncate)[^"]*"[^>]*>(.*?)<\/div>/g
    ),
    ...html.matchAll(
      /<span[^>]*class="[^"]*a-truncate-full[^"]*"[^>]*>(.*?)<\/span>/g
    ),
    ...html.matchAll(/<img[^>]*alt="([^"]+)"[^>]*>/g),
  ];

  const seen = new Set<string>();

  return matches
    .map((m) => cleanAmazonTitle(m[1]))
    .filter((title) => {
      const normalized = normalizeTrendName(title);

      if (!title || title.length < 8) return false;
      if (title === "Amazon") return false;
      if (title.toLowerCase().includes("amazon ads")) return false;
      if (title.toLowerCase().includes("sponsored")) return false;
      if (title.toLowerCase().startsWith("new releases")) return false;
      if (seen.has(normalized)) return false;

      seen.add(normalized);
      return true;
    })
    .slice(0, 25);
}

async function buildAmazonCandidates(category: string) {
  const amazonNewReleaseUrlsByCategory: Record<string, string[]> = {
    Toys: [
      "https://www.amazon.com/gp/new-releases/toys-and-games/ref=zg_bsnr_nav_toys-and-games_0",
    ],
    Cellular: [
      "https://www.amazon.com/gp/new-releases/wireless/ref=zg_bsnr_nav_wireless_0",
    ],
  };

  const categoriesToFetch =
    category === "All"
      ? ["Toys", "Novelty Food", "Cellular", "General Merchandise"]
      : [category];

  const amazonItems: { title: string; category: string; index: number }[] = [];

  for (const currentCategory of categoriesToFetch) {
    const urls = amazonNewReleaseUrlsByCategory[currentCategory] || [];

    for (const url of urls) {
      try {
        const amazonTitles = await fetchAmazonNewReleaseTitles(url);

        console.log(`Amazon New Releases titles for ${currentCategory}:`, amazonTitles);

        amazonTitles.slice(0, 12).forEach((title, index) => {
          amazonItems.push({
            title,
            category: currentCategory,
            index,
          });
        });
      } catch (error) {
        console.error(`Amazon New Releases fetch failed for ${currentCategory}:`, error);
      }
    }
  }

  const phraseCounts = buildAutomaticTrendPhraseCounts(
    amazonItems.map((item) => item.title)
  );

  console.log(
    "Automatic Amazon trend phrases:",
    Array.from(phraseCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => getPhraseScore(b[0], b[1]) - getPhraseScore(a[0], a[1]))
      .slice(0, 20)
  );

  return amazonItems.map((item) => ({
    productName: item.title,
    trendCategory: inferAutomaticTrendCategory(item.title, phraseCounts),
    category: item.category,
    sources: ["Amazon"],
    mentions: 10000 - item.index * 500,
    growthPercent: 100 - item.index * 3,
    score: 90 - item.index,
    status: "Watching",
    notes: `Amazon New Releases source: ${item.category}`,
  }));
}

function mergeTrendCandidates(candidates: any[]) {
  const merged = new Map<string, any>();

  for (const candidate of candidates) {
    const key = normalizeTrendName(candidate.productName);

    if (!merged.has(key)) {
      merged.set(key, {
        ...candidate,
        sources: candidate.sources || [candidate.source],
      });
      continue;
    }

    const existing = merged.get(key);

    merged.set(key, {
      ...existing,
      sources: Array.from(
        new Set([
          ...(existing.sources || []),
          ...(candidate.sources || [candidate.source]),
        ])
      ),
      mentions: Math.max(existing.mentions || 0, candidate.mentions || 0),
      growthPercent: Math.max(
        existing.growthPercent || 0,
        candidate.growthPercent || 0
      ),
      score: Math.max(existing.score || 0, candidate.score || 0),
      notes: `${existing.notes || ""} | ${candidate.notes || ""}`,
    });
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category") || "All";

  const searchTermsByCategory: Record<string, string[]> = {
    Toys: ["viral toys", "collectible toys", "blind box toys"],
    Cellular: ["phone accessories", "charging accessories", "mobile gadgets"],
    "Novelty Food": ["viral candy", "freeze dried candy", "novelty snacks"],
    "General Merchandise": ["impulse buys", "convenience store gadgets"],
  };

  const searchTerms =
    category === "All"
      ? Object.values(searchTermsByCategory).flat()
      : searchTermsByCategory[category] || [];

  const googleCandidates = buildGoogleTrendsCandidates(
    searchTerms.slice(0, 10),
    category
  );

  const tikTokCandidates = buildTikTokCandidates(category);
  const amazonCandidates = await buildAmazonCandidates(category);

  const mergedCandidates = mergeTrendCandidates([
    ...googleCandidates,
    ...tikTokCandidates,
    ...amazonCandidates,
  ]);

  return NextResponse.json({
    candidates: mergedCandidates,
  });
}
