import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

if (scripts.length === 0) {
  throw new Error('index.html에서 inline script를 찾을 수 없습니다');
}

for (const [index, match] of scripts.entries()) {
  try {
    new Function(match[1]);
  } catch (error) {
    throw new Error(`index.html inline script #${index + 1} 문법 오류: ${error.message}`);
  }
}

console.log(`Validated ${scripts.length} inline script block(s).`);
