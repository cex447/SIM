/*
 * Compatibilitat de nom de mòdul.
 *
 * Des de Beta 3.16.0 iSIC és una imatge PNG i tota la lectura/matching viu a
 * isic.js. Aquest fitxer es conserva perquè cap desplegament antic que encara
 * tingui una referència al nom platform-3.43.0.js acabi carregant el parser DOM/CORS
 * obsolet de 3.13.
 */
export {
  cachedPlatform,
  cachedPlatformByCirculation,
  clearAllIsicCaches,
  clearPlatform,
  fetchIsicStation,
  fixedPlatformFor,
  fallbackPlatformFor,
  platformPolicyFor,
  suppressPlatformFor,
  matchContextToRows,
  matchContextsToRows,
  normalizePlatformValue,
  pairAssessment,
  parseIsicImageData,
  rememberPlatform
} from "./isic-3.43.0.js";
