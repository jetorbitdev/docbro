export interface CommentData {
  id: string;
  author: string;
  date: string; // ISO
  text: string;
  editing?: boolean;
}

export interface DocMeta {
  comments: CommentData[];
  header: string | null;
  footer: string | null;
  pageNumbers: boolean;
}

export const emptyMeta = (): DocMeta => ({ comments: [], header: null, footer: null, pageNumbers: false });
