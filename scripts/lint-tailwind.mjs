import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isFix = process.argv.includes('--fix');

function findLspPath() {
  const local = path.resolve('node_modules/.bin/tailwindcss-language-server');
  if (fs.existsSync(local)) return local;
  const zed = path.join(
    process.env.HOME || '',
    'Library/Application Support/Zed/languages/tailwindcss-language-server/node_modules/.bin/tailwindcss-language-server'
  );
  if (fs.existsSync(zed)) return zed;
  return 'tailwindcss-language-server';
}

function getAllFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') {
        results = results.concat(getAllFiles(full));
      }
    } else if (
      /\.(tsx|jsx)$/.test(entry.name) &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

const lspPath = findLspPath();
const uiSrcDir = path.resolve('ui/src');
const files = getAllFiles(uiSrcDir);

if (files.length === 0) {
  console.log('No UI files found to scan.');
  process.exit(0);
}

const child = spawn(lspPath, ['--stdio'], {
  cwd: path.resolve('.'),
  env: process.env,
});

let buffer = Buffer.alloc(0);
const diagnosticsMap = new Map();
let finishTimeout = null;

function send(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n`;
  child.stdin.write(header + json);
}

function finish() {
  if (finishTimeout) clearTimeout(finishTimeout);

  console.log(`\n=== Tailwind Language Server Diagnostics ===`);
  console.log(`Tool: @tailwindcss/language-server (same engine as Zed IDE)`);
  console.log(`Scanned ${files.length} UI files.`);

  let totalDiagnostics = 0;
  for (const [, diags] of diagnosticsMap) {
    totalDiagnostics += diags.length;
  }

  if (totalDiagnostics === 0) {
    console.log(`✓ All Tailwind classes are canonical. No warnings or errors found.\n`);
    try {
      child.kill();
    } catch {}
    process.exit(0);
  }

  if (isFix) {
    console.log(`\nApplying fixes for ${totalDiagnostics} diagnostic(s) across ${diagnosticsMap.size} file(s)...\n`);
    let totalFixed = 0;

    for (const [uri, diags] of diagnosticsMap) {
      let filePath;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        filePath = uri.replace(/^file:\/\//, '');
      }

      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const fixable = diags
        .filter((d) => d.suggestions && d.suggestions.length > 0)
        .sort(
          (a, b) =>
            b.range.start.line - a.range.start.line ||
            b.range.start.character - a.range.start.character
        );

      let fileChanged = false;
      for (const d of fixable) {
        const { start, end } = d.range;
        const replacement = d.suggestions[0];
        if (start.line === end.line && start.line < lines.length) {
          const line = lines[start.line];
          const orig = line.slice(start.character, end.character);
          lines[start.line] =
            line.slice(0, start.character) + replacement + line.slice(end.character);
          fileChanged = true;
          totalFixed++;
          const relPath = path.relative(process.cwd(), filePath);
          console.log(
            `  \x1b[4m${relPath}\x1b[0m:\x1b[33m${start.line + 1}:${start.character + 1}\x1b[0m \x1b[31m${orig}\x1b[0m -> \x1b[32m${replacement}\x1b[0m`
          );
        }
      }

      if (fileChanged) {
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      }
    }

    console.log(`\n✓ Successfully fixed ${totalFixed} class(es).\n`);
    try {
      child.kill();
    } catch {}
    process.exit(0);
  } else {
    console.log(`Found ${totalDiagnostics} warning(s) in ${diagnosticsMap.size} file(s):\n`);

    for (const [uri, diags] of diagnosticsMap) {
      let filePath;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        filePath = uri.replace(/^file:\/\//, '');
      }
      const relPath = path.relative(process.cwd(), filePath);
      console.log(`\x1b[4m${relPath}\x1b[0m:`);
      for (const d of diags) {
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const suggestion =
          d.suggestions && d.suggestions.length > 0
            ? ` -> \x1b[32m${d.suggestions[0]}\x1b[0m`
            : '';
        console.log(
          `  \x1b[33mline ${line}:${col}\x1b[0m: ${d.message}${suggestion} (\x1b[90m${d.code || 'tailwindcss'}\x1b[0m)`
        );
      }
      console.log('');
    }

    console.log(`Tip: run 'pnpm lint:tailwind:fix' to automatically apply all canonical suggestions.\n`);
    try {
      child.kill();
    } catch {}
    process.exit(1);
  }
}

child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const headerStr = buffer.slice(0, headerEnd).toString('utf-8');
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len).toString('utf-8');
    buffer = buffer.slice(bodyStart + len);

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }

    if (parsed.method === 'workspace/configuration') {
      const items = (parsed.params?.items || []).map(() => ({
        editor: { tabSize: 2 },
        tailwindCSS: {
          lint: {
            suggestCanonicalVal: 'warning',
            invalidApply: 'error',
            invalidScreen: 'error',
            invalidVariant: 'error',
            invalidConfigPath: 'error',
            invalidTailwindDirective: 'error',
            recommendedVariantOrder: 'warning',
          },
          validate: true,
        },
      }));
      send({ jsonrpc: '2.0', id: parsed.id, result: items });
    } else if (parsed.method === 'textDocument/publishDiagnostics') {
      const uri = parsed.params.uri;
      const diags = parsed.params.diagnostics || [];
      if (diags.length > 0) {
        diagnosticsMap.set(uri, diags);
      }
      if (finishTimeout) clearTimeout(finishTimeout);
      finishTimeout = setTimeout(finish, 1200);
    }
  }
});

child.on('error', (err) => {
  console.error('Failed to run tailwindcss-language-server:', err);
  process.exit(1);
});

// Initialize LSP connection
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    processId: process.pid,
    rootUri: pathToFileURL(path.resolve('.')).href,
    rootPath: path.resolve('.'),
    capabilities: {
      workspace: { configuration: true },
      textDocument: { publishDiagnostics: { relatedInformation: true } },
    },
  },
});

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  for (const file of files) {
    const uri = pathToFileURL(file).href;
    const text = fs.readFileSync(file, 'utf-8');
    send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId: 'typescriptreact',
          version: 1,
          text,
        },
      },
    });
  }

  // Safety fallback if no diagnostics are returned
  finishTimeout = setTimeout(finish, 7000);
}, 800);
