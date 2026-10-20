// Runs dist/cli.js in its own process with the anchor key of the tests (first argument): the tool never reads a key file
// from an option or a variable, so a test that spawns it sets the key in the process before loading it.
import { setAnchorKeyFile } from '../../dist/rules/operator.js';

const [keyFile, ...args] = process.argv.slice(2);
setAnchorKeyFile(keyFile);
const cli = new URL('../../dist/cli.js', import.meta.url);
process.argv = [process.argv[0], cli.pathname, ...args];
await import(cli.href);
