import { defineConfig } from 'tsup';

/**
 * Two build steps, not one — deliberately.
 *
 * The library entry (`index`) ships dual ESM + CJS so either kind of
 * consumer can `import` or `require` it. The CLI entry (`cli/index`) ships
 * ESM only: it is never `require()`-d — npm invokes it as a program via
 * its shebang, not as a module — and building it as CommonJS would force
 * every ESM-only dependency pulled in transitively (directly or through
 * this package's own future dependencies) to be bundled or dropped.
 * Keeping the bin ESM-only sidesteps that entire class of dual-format
 * packaging hazard rather than working around it dependency by dependency.
 *
 * Both entries run as a single `tsup` invocation, and tsup does not
 * guarantee they run sequentially — so neither config below sets
 * `clean: true` (two configs racing to clean the same `dist/` could wipe
 * out whichever one finished writing first). `dist/` is removed once,
 * synchronously, by the `build` script in package.json before tsup ever
 * starts — deterministic regardless of how tsup schedules the two entries.
 */
export default defineConfig([
  {
    name: 'lib',
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.js' };
    },
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    target: 'node20',
    platform: 'node',
  },
  {
    name: 'cli',
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    outExtension() {
      return { js: '.js' };
    },
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    target: 'node20',
    platform: 'node',
  },
]);
