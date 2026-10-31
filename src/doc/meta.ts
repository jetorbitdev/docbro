export interface CommentData {
  id: string;
  author: string;
  date: string; // ISO
  text: string;
  editing?: boolean;
}

/** 1440 twips to the inch and 96 px to the inch. */
export const TWIPS_PER_PX = 15;

export type PageSize = "letter" | "a4";

/** The paper in twips (1/20 pt), as Word writes `w:pgSz`; the page layout takes its proportions from it. */
export const PAPER: Record<PageSize, { width: number; height: number }> = {
  letter: { width: 12240, height: 15840 },
  a4: { width: 11906, height: 16838 },
};

export interface DocMeta {
  comments: CommentData[];
  header: string | null;
  footer: string | null;
  pageNumbers: boolean;
  pageSize: PageSize;
}

export const emptyMeta = (): DocMeta => ({ comments: [], header: null, footer: null, pageNumbers: false, pageSize: "letter" });
