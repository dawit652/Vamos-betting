export * from './common';
export * from './registry';
export { createOpenFootballAdapter, OpenFootballConfigSchema } from './openfootball';
export type { OpenFootballConfig } from './openfootball';
export {
  createGenericJsonAdapter,
  GenericJsonConfigSchema,
  parsePath,
  resolvePath,
} from './generic-json';
export type { GenericJsonConfig, PathSegment } from './generic-json';
export { createGenericHtmlAdapter, GenericHtmlConfigSchema } from './generic-html';
export type { GenericHtmlConfig } from './generic-html';
