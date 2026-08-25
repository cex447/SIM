/*
 * Compatibilitat de nom de mòdul.
 *
 * Des de Beta 3.14.0 iSIC és una imatge PNG i tota la lectura/matching viu a
 * isic.js. Aquest fitxer es conserva perquè cap desplegament antic que encara
 * tingui una referència al nom platform.js acabi carregant el parser DOM/CORS
 * obsolet de 3.13.
 */
export {
  cachedPlatform,
  clearAllIsicCaches,
  clearPlatform,
  fetchIsicStation,
  fixedPlatformFor,
  matchContextToRows,
  matchContextsToRows,
  pairAssessment,
  parseIsicImageData,
  rememberPlatform
} from "./isic.js?v=3.14.0";
