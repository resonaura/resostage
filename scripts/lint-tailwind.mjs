import fs from 'node:fs';
import path from 'node:path';

const isFix = process.argv.includes('--fix');

// Canonical Tailwind scale mapping (matching @tailwindcss/language-server)
const SPACING_MAP = {
  '0px': '0',
  '1px': 'px',
  '2px': '0.5',
  '4px': '1',
  '6px': '1.5',
  '8px': '2',
  '10px': '2.5',
  '12px': '3',
  '14px': '3.5',
  '16px': '4',
  '20px': '5',
  '24px': '6',
  '28px': '7',
  '32px': '8',
  '36px': '9',
  '40px': '10',
  '44px': '11',
  '48px': '12',
  '56px': '14',
  '64px': '16',
  '72px': '18',
  '80px': '20',
  '96px': '24',
  '100%': 'full',
  '100vw': 'screen',
  '100vh': 'screen',
};

const FONT_SIZE_MAP = {
  '12px': 'xs',
  '14px': 'sm',
  '16px': 'base',
  '18px': 'lg',
  '20px': 'xl',
  '24px': '2xl',
  '30px': '3xl',
  '36px': '4xl',
  '0.75rem': 'xs',
  '0.875rem': 'sm',
  '1rem': 'base',
  '1.125rem': 'lg',
  '1.25rem': 'xl',
  '1.5rem': '2xl',
};

const ROUNDED_MAP = {
  '0px': 'none',
  '2px': 'sm',
  '4px': 'md',
  '6px': 'md',
  '8px': 'lg',
  '12px': 'xl',
  '16px': '2xl',
  '24px': '3xl',
  '9999px': 'full',
};

const OPACITY_MAP = {
  '0': '0',
  '0.05': '5',
  '0.1': '10',
  '0.15': '15',
  '0.2': '20',
  '0.25': '25',
  '0.3': '30',
  '0.4': '40',
  '0.5': '50',
  '0.6': '60',
  '0.7': '70',
  '0.75': '75',
  '0.8': '80',
  '0.9': '90',
  '0.95': '95',
  '1': '100',
};

const Z_MAP = {
  '0': '0',
  '10': '10',
  '20': '20',
  '30': '30',
  '40': '40',
  '50': '50',
  'auto': 'auto',
};

const SPACING_PREFIXES = [
  'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'ps', 'pe',
  'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'ms', 'me',
  'w', 'min-w', 'max-w',
  'h', 'min-h', 'max-h',
  'gap', 'gap-x', 'gap-y',
  'top', 'bottom', 'left', 'right', 'inset', 'inset-x', 'inset-y',
  'space-x', 'space-y',
  'size',
];

function checkClassName(cls) {
  const match = cls.match(/^([a-z0-9/:-]+)-\[([^\]]+)\]$/);
  if (!match) return null;

  const fullPrefix = match[1];
  const value = match[2].trim();

  const parts = fullPrefix.split(':');
  const baseProp = parts.pop();
  const variants = parts.length > 0 ? parts.join(':') + ':' : '';

  // 1. Spacing properties
  if (SPACING_PREFIXES.includes(baseProp)) {
    if (SPACING_MAP[value]) {
      const canonical = `${variants}${baseProp}-${SPACING_MAP[value]}`;
      return { original: cls, canonical, reason: `Value '${value}' has native token '${SPACING_MAP[value]}'` };
    }
  }

  // 2. Font size: text-[12px] -> text-xs
  if (baseProp === 'text') {
    if (FONT_SIZE_MAP[value]) {
      const canonical = `${variants}text-${FONT_SIZE_MAP[value]}`;
      return { original: cls, canonical, reason: `Font size '${value}' has native token '${FONT_SIZE_MAP[value]}'` };
    }
  }

  // 3. Rounded: rounded-[4px] -> rounded-md
  if (baseProp === 'rounded') {
    if (ROUNDED_MAP[value]) {
      const token = ROUNDED_MAP[value] === 'DEFAULT' ? '' : `-${ROUNDED_MAP[value]}`;
      const canonical = `${variants}rounded${token}`;
      return { original: cls, canonical, reason: `Border radius '${value}' has native token 'rounded${token}'` };
    }
  }

  // 4. Opacity: opacity-[0.5] -> opacity-50
  if (baseProp === 'opacity') {
    if (OPACITY_MAP[value]) {
      const canonical = `${variants}opacity-${OPACITY_MAP[value]}`;
      return { original: cls, canonical, reason: `Opacity '${value}' has native token '${OPACITY_MAP[value]}'` };
    }
  }

  // 5. Z-Index: z-[10] -> z-10
  if (baseProp === 'z') {
    if (Z_MAP[value]) {
      const canonical = `${variants}z-${Z_MAP[value]}`;
      return { original: cls, canonical, reason: `Z-index '${value}' can be written without brackets 'z-${Z_MAP[value]}'` };
    }
  }

  return null;
}

const UI_DIR = path.resolve('ui/src');
let totalWarnings = 0;
let totalFixed = 0;
const resultsByFile = new Map();

function scanFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  let fileModified = false;
  const lines = content.split('\n');

  lines.forEach((line, lineIdx) => {
    const classMatches = line.matchAll(/(?:className|class)\s*=\s*(?:["'`]([^"'`]+)["'`]|{`([^`]+)`})/g);
    for (const cm of classMatches) {
      const classStr = cm[1] || cm[2] || '';
      const tokens = classStr.split(/\s+/);
      for (const token of tokens) {
        if (!token) continue;
        const warning = checkClassName(token);
        if (warning) {
          totalWarnings++;
          const relPath = path.relative(process.cwd(), filePath);
          if (!resultsByFile.has(relPath)) {
            resultsByFile.set(relPath, []);
          }
          resultsByFile.get(relPath).push({
            line: lineIdx + 1,
            ...warning
          });
        }
      }
    }
  });

  if (isFix && resultsByFile.has(path.relative(process.cwd(), filePath))) {
    const items = resultsByFile.get(path.relative(process.cwd(), filePath));
    for (const item of items) {
      const escaped = item.original.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`(?<=[\\s"'\\\`])${escaped}(?=[\\s"'\\\`])`, 'g');
      content = content.replace(regex, item.canonical);
      fileModified = true;
      totalFixed++;
    }
    if (fileModified) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }
}

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full);
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx')) {
      scanFile(full);
    }
  }
}

walkDir(UI_DIR);

console.log(`\n=== Tailwind Canonical Utility Linter ===`);
if (totalWarnings === 0) {
  console.log(`✓ All arbitrary values are canonical. No unnecessary bracketed values found.`);
  process.exit(0);
} else {
  if (isFix) {
    console.log(`✓ Automatically fixed ${totalFixed} arbitrary class(es).\n`);
  } else {
    console.log(`Found ${totalWarnings} unnecessary arbitrary value(s):\n`);
    for (const [file, items] of resultsByFile) {
      console.log(`\x1b[4m${file}\x1b[0m:`);
      for (const item of items) {
        console.log(`  \x1b[33mline ${item.line}\x1b[0m: \x1b[31m${item.original}\x1b[0m -> \x1b[32m${item.canonical}\x1b[0m (\x1b[90m${item.reason}\x1b[0m)`);
      }
      console.log('');
    }
    console.log(`Tip: run 'node scripts/lint-tailwind.mjs --fix' to automatically replace them.\n`);
  }
}
