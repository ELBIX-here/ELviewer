/**
 * Effective number of side-by-side pages for the "단 수" setting.
 * Automatic (0) shows two pages when the reading area is wide and not much taller
 * than it is wide – a landscape window, a tablet on its side or an unfolded foldable –
 * and one page on ordinary phone screens.
 */
export function effectiveColumns(setting: 0 | 1 | 2, width: number, height: number): 1 | 2 {
  if (setting !== 0) return setting;
  return width >= 600 && width >= height * 0.75 ? 2 : 1;
}
