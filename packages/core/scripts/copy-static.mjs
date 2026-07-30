// Copies the dashboard's static HTML/CSS/JS assets into dist/ after tsup
// runs. tsup only bundles .ts/.js entry points — it has no notion of
// plain static files — so without this step, the compiled CLI would
// look for assets that were never shipped once installed as a package
// (only `dist/` and `README.md` are published; `src/` is not).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, 'src', 'dashboard', 'static');
const destination = join(packageRoot, 'dist', 'dashboard', 'static');

if (!existsSync(source)) {
  throw new Error(`Dashboard static source directory not found: ${source}`);
}

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });

console.log(`Copied dashboard static assets:\n  ${source}\n  -> ${destination}`);
