export interface Article {
  id: string;
  slug: string;
  title: string;
  category_id: number;
  category_name: string;
  source_url: string | null;
  content: string;
  content_html: string | null;
  word_count: number | null;
  file_path: string | null;
  article_order: number | null;
  is_stub: boolean;
  created_at: string;
  updated_at: string;
}

export interface ArticleInsert {
  slug: string;
  title: string;
  category_id: number;
  category_name: string;
  category_slug?: string;
  source_url: string | null;
  content: string;
  content_html: string | null;
  word_count: number | null;
  file_path?: string | null;
  article_order: number | null;
  is_stub: boolean;
}

export interface ArticleMetadata {
  id: string;
  slug: string;
  title: string;
  category_id: number;
  category_name: string;
  source_url: string | null;
  word_count: number | null;
  article_order: number | null;
  is_stub: boolean;
  created_at: string;
}
