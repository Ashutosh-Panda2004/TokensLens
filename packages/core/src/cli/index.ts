#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { TokenLensError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof TokenLensError) {
    logger.error(error.message);
    if (Object.keys(error.context).length > 0) {
      logger.debug('context:', error.context);
    }
    process.exitCode = 1;
    return;
  }

  if (error instanceof CommanderError) {
    // exitOverride() (createProgram) turns commander's own process.exit()
    // calls — --help, --version, usage errors — into a thrown
    // CommanderError instead, so we set exitCode and let the process exit
    // naturally rather than commander killing it mid-write.
    process.exitCode = error.exitCode;
    return;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  logger.error('Unexpected internal error.', detail);
  process.exitCode = 1;
});
