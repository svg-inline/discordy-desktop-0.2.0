import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedTag = `v${pkg.version}`;
const actualTag = process.env.GITHUB_REF_NAME || process.argv[2] || '';

if (!actualTag) {
  console.error(`[release] informe a tag: npm run release:validate -- ${expectedTag}`);
  process.exit(1);
}

if (actualTag !== expectedTag) {
  console.error(`[release] tag ${actualTag} não corresponde ao package.json ${pkg.version}. Esperado: ${expectedTag}`);
  process.exit(1);
}

console.log(`[release] versão validada: ${expectedTag}`);
