import { readFile } from 'node:fs/promises';

const surfaceFiles = [
  'src/App.tsx',
  'src/components/SettingsModal.tsx',
  'src/components/Sidebar.tsx',
  'src/components/worklogs/WorkLogVoiceBar.tsx',
];
const css = await readFile('src/index.css', 'utf8');
const html = await readFile('index.html', 'utf8');
const requiredTokens = [
  '--canvas', '--surface-1', '--surface-2', '--text-primary',
  '--text-secondary', '--text-muted', '--control-border', '--focus-ring',
];
const failures = [];

for (const token of requiredTokens) {
  const occurrences = css.split(token).length - 1;
  if (occurrences < 2) failures.push(`${token} must be defined for dark and light themes`);
}

for (const file of surfaceFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes('transition-all')) failures.push(`${file} still contains transition-all`);
}

if (/\[class\*=['"](?:bg|border)-(?:white|slate)/.test(css)) {
  failures.push('theme bridge must not substring-match background or border class attributes');
}
if (!html.includes("document.documentElement.dataset.theme")) failures.push('pre-paint theme bootstrap is missing');
if (!html.includes('name="color-scheme"')) failures.push('native color-scheme metadata is missing');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Theme contract OK (${requiredTokens.length} paired tokens, ${surfaceFiles.length} surfaces).`);
}
