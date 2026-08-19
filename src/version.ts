/**
 * The package version. Kept as a tiny module so CLI/help/`--list-plugins`
 * read it without importing `package.json` (which needs a JSON import
 * attribute). Bump it together with `package.json`.
 */
export const version = '0.1.0'
