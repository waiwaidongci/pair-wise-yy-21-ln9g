// 用 esbuild 把 node:test 测试打包成 ESM，再交给 Node 运行。
// 不引入额外测试框架，保持与前端同一套 TypeScript 源码。
import { build } from 'esbuild';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const entryPoints = process.argv.slice(2);
const files =
  entryPoints.length > 0
    ? entryPoints
    : readdirSync('tests')
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => join('tests', name));

const dir = mkdtempSync(join(tmpdir(), 'stowage-tests-'));
try {
  await build({
    entryPoints: files,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outdir: dir,
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  const bundles = files.map((file) => join(dir, basename(file).replace(/\.ts$/, '.js')));
  execFileSync(process.execPath, ['--test', ...bundles], { stdio: 'inherit' });
} catch (error) {
  if (error && typeof error === 'object' && 'status' in error) process.exit(error.status ?? 1);
  throw error;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
