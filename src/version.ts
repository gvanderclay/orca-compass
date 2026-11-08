import { createRequire } from 'node:module';

/** The running package's version, from package.json (one folder above dist/ and src/ alike). */
export const VERSION: string = createRequire(import.meta.url)('../package.json').version;
