// Runs a hook of the plugin as Claude Code does (its input on standard input), with the anchor key of a test: the key
// file is set in this process (setAnchorKeyFile, on the very module the hook imports), never through the environment,
// which no hook reads for it. Usage: node test/support/run-hook.mjs <hook file> <key file>
import { pathToFileURL } from 'node:url';

const [hook, keyFile] = process.argv.slice(2);
if (!hook || !keyFile) {
  process.stderr.write('usage : node test/support/run-hook.mjs <crochet> <fichier de clé>\n');
  process.exit(2);
}
const { setAnchorKeyFile } = await import(new URL('../../dist/rules/operator.js', import.meta.url).href);
setAnchorKeyFile(keyFile);
const { main } = await import(pathToFileURL(hook).href);
try { process.exitCode = await main(); } catch (error) {
  // As the hook itself does when Claude Code runs it: an error never blocks the session.
  process.stderr.write(`APV ${hook} : ${error?.message ?? error}\n`);
  process.exitCode = 0;
}
