/** Root dotfolder for all TokenLens local state (config, cache, ledger DB). */
export const TOKENLENS_DIR = '.tokenlens';

/** Filename of the user-authored configuration file inside {@link TOKENLENS_DIR}. */
export const CONFIG_FILE_NAME = 'config.json';

/** Filename of the SQLite credit ledger inside {@link TOKENLENS_DIR}. */
export const LEDGER_DB_FILE_NAME = 'ledger.sqlite3';

/** The published package / binary name — used in help text and error messages. */
export const PACKAGE_NAME = 'tokenlens';
