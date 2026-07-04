export interface CategoryDef {
  id: number;
  slug: string;
  name: string;
  description: string;
  articleCount: number;
  source: "old" | "new";
}

export const CATEGORIES: CategoryDef[] = [
  { id: 1, slug: "common-questions-and-claims", name: "Common Questions and Claims", description: "Answers to frequently raised questions about the deity of Christ, the Trinity, and Christian theology.", articleCount: 57, source: "old" },
  { id: 2, slug: "general-issues", name: "General Issues", description: "Broad topics covering Biblical authority, women in Islam and the Bible, and open challenges.", articleCount: 27, source: "old" },
  { id: 3, slug: "theological-issues", name: "Theological Issues", description: "Islamic monotheism, Allah's attributes, the Trinity in the Old Testament, and comparative theology.", articleCount: 33, source: "old" },
  { id: 4, slug: "christological-issues", name: "Christological Issues", description: "The deity of Christ, Jesus in the Bible and Quran, worship of Jesus, and Messianic prophecy.", articleCount: 73, source: "old" },
  { id: 5, slug: "quranic-issues", name: "Quranic Issues", description: "Quran textual criticism, variant readings, the Quran's witness to the Bible, and internal contradictions.", articleCount: 47, source: "old" },
  { id: 6, slug: "analysis-of-muhammad", name: "Analysis of Muhammad", description: "Muhammad's prophecies, miracles, marriages, character, and claims examined against Biblical standards.", articleCount: 40, source: "old" },
  { id: 7, slug: "hadith-literature", name: "Hadith Literature", description: "Analysis of hadith reports on cosmology, fables, and theological implications.", articleCount: 6, source: "old" },
  { id: 8, slug: "polemical-issues", name: "Polemical Issues", description: "Abraham and the sacrifice, the Holy Spirit, Paul and Islam, and ethical critiques.", articleCount: 20, source: "old" },
  { id: 9, slug: "debate-challenges", name: "Debate Challenges", description: "Open debate challenges and responses to Muslim debaters.", articleCount: 3, source: "old" },
  { id: 10, slug: "debate-material", name: "Debate Material", description: "Prepared material for formal debates on Islam and Christianity.", articleCount: 2, source: "old" },
  { id: 11, slug: "articles-on-other-websites", name: "Articles on Other Websites", description: "Sam Shamoun's articles published on external sites including Abrahamic Faith.", articleCount: 20, source: "old" },
  { id: 12, slug: "new-common-questions", name: "New Common Questions", description: "Recent answers to Muslim questions about Christ's sacrifice, deity, and mission.", articleCount: 8, source: "new" },
  { id: 13, slug: "short-summary-articles", name: "Short Summary Articles", description: "Concise summaries of key theological arguments.", articleCount: 1, source: "new" },
  { id: 14, slug: "turning-the-tables", name: "Turning the Tables", description: "Reversing common Islamic objections back against Islamic theology.", articleCount: 4, source: "new" },
  { id: 15, slug: "new-christological-issues", name: "New Christological Issues", description: "Extensive newer articles on Christ's deity, worship, the Incarnation, and Messianic prophecy.", articleCount: 185, source: "new" },
  { id: 16, slug: "new-theological-issues", name: "New Theological Issues", description: "Allah's attributes, Islamic monotheism critiques, the Shema, salvation, and atonement.", articleCount: 75, source: "new" },
  { id: 17, slug: "biblical-issues", name: "Biblical Issues", description: "Biblical inspiration, canon, the Apocrypha, and John's Gospel reliability.", articleCount: 12, source: "new" },
  { id: 18, slug: "new-quranic-issues", name: "New Quranic Issues", description: "Quran confirms the Trinity, textual corruption, flat earth, and theological contradictions.", articleCount: 46, source: "new" },
  { id: 19, slug: "new-analysis-of-muhammad", name: "New Analysis of Muhammad", description: "Muhammad's deification, false prophecies, treatment of women, and relationship with Allah.", articleCount: 71, source: "new" },
  { id: 20, slug: "responses-to-muslim-authors", name: "Responses to Muslim Authors", description: "Rebuttals to specific Muslim scholars and debaters including Shabir Ally, Zakir Naik, and others.", articleCount: 18, source: "new" },
  { id: 21, slug: "max-shimba-ministries", name: "Max Shimba Ministries", description: "Articles by Dr. Maxwell Shimba addressing Islamic theology, Quranic contradictions, and Muhammad from a biblical perspective.", articleCount: 624, source: "new" }
];

export const TOTAL_ARTICLES = CATEGORIES.reduce((sum, category) => sum + category.articleCount, 0);
export const TOTAL_CATEGORIES = CATEGORIES.length;

export function getCategoryBySlug(slug: string): CategoryDef | undefined {
  return CATEGORIES.find((category) => category.slug === slug);
}

export function getCategoryById(id: number): CategoryDef | undefined {
  return CATEGORIES.find((category) => category.id === id);
}

export function getCategoryByFolderName(folderName: string): CategoryDef | undefined {
  const idMatch = folderName.match(/^(\d+)_/);
  if (!idMatch) return undefined;
  return getCategoryById(parseInt(idMatch[1], 10));
}
