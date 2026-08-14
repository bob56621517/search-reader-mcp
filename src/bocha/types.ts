/**
 * 博查搜索的数据结构(能力层 VO)。
 * 参考实现:xyz-mcp-hub 的 io.xyz.xyz_mcp_hub.bocha 包。
 */

/** 网页搜索/参考源的一条网页结果(对应官网 webPages.value[]) */
export interface WebPage {
  name: string;
  url: string;
  siteName: string;
  snippet: string;
  summary: string;
}

/** AI 搜索的模态卡(垂域结构化数据,如 weather_china / baike_pro) */
export interface ModalCard {
  contentType: string;
  modelCardJson: string;
}

/** AI 搜索的完整结果 */
export interface AiSearchResult {
  /** AI 总结答案(Markdown;无则 null) */
  summary: string | null;
  pages: WebPage[];
  modalCards: ModalCard[];
  followUpQuestions: string[];
}
