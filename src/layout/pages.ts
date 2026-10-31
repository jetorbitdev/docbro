/** About 1056px of paper: the mock's page-height estimate (mock 134–155). */
const PAGE_HEIGHT_PX = 1056;

export function estimatePages(paperHeightPx: number): number {
  return Math.max(1, Math.ceil(paperHeightPx / PAGE_HEIGHT_PX));
}

export function pageLabel(on: boolean, pages: number): string {
  return on ? `Page 1 of ${pages}` : "# Add page numbers";
}
