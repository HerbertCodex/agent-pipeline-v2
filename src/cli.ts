#!/usr/bin/env node
import { dispatch } from './commands/index.js';
import type { CommandIO } from './commands/io.js';

/** Terminal adapter: commands write text; a missing final newline is added so both styles print cleanly. */
const line = (write: (s: string) => boolean) => (s: string): void => { write(s.endsWith('\n') ? s : `${s}\n`); };
const io: CommandIO = {
  stdout: line(s => process.stdout.write(s)),
  stderr: line(s => process.stderr.write(s)),
  cwd: process.cwd(),
  env: process.env,
};
dispatch(process.argv.slice(2), io).then(code => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`apv : erreur inattendue : ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
