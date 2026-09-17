/**
 * Detecção de comentários por linguagem, para o treino pular o que é comentário.
 *
 * Para cada linha do gabarito devolve quantos caracteres o usuário precisa digitar:
 *   0                → linha inteira é comentário (ou está dentro de um bloco); é preenchida sozinha
 *   n < line.length  → há comentário no fim da linha; ao digitar os n primeiros o resto é preenchido
 *   line.length      → sem comentário
 */

interface Rules {
  line: string[];
  block: [string, string][];
}

const C_LIKE: Rules = { line: ['//'], block: [['/*', '*/']] };
const HASH: Rules = { line: ['#'], block: [] };
const HTML: Rules = { line: [], block: [['<!--', '-->']] };

const RULES: Record<string, Rules> = {
  javascript: C_LIKE, typescript: C_LIKE, javascriptreact: C_LIKE, typescriptreact: C_LIKE,
  java: C_LIKE, c: C_LIKE, cpp: C_LIKE, csharp: C_LIKE, go: C_LIKE, rust: C_LIKE, php: C_LIKE,
  swift: C_LIKE, kotlin: C_LIKE, dart: C_LIKE, scala: C_LIKE, groovy: C_LIKE, objectivec: C_LIKE,
  scss: C_LIKE, less: C_LIKE, jsonc: C_LIKE, json: C_LIKE, prisma: C_LIKE,
  css: { line: [], block: [['/*', '*/']] },
  python: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]] },
  ruby: { line: ['#'], block: [['=begin', '=end']] },
  shellscript: HASH, yaml: HASH, toml: HASH, perl: HASH, r: HASH, dockerfile: HASH, makefile: HASH,
  ini: { line: ['#', ';'], block: [] },
  properties: { line: ['#', '!'], block: [] },
  powershell: { line: ['#'], block: [['<#', '#>']] },
  sql: { line: ['--'], block: [['/*', '*/']] },
  lua: { line: ['--'], block: [['--[[', ']]']] },
  haskell: { line: ['--'], block: [['{-', '-}']] },
  html: HTML, xml: HTML, vue: HTML, svelte: HTML, markdown: HTML,
  clojure: { line: [';'], block: [] },
  lisp: { line: [';'], block: [] },
  bat: { line: ['REM ', 'rem ', '::'], block: [] },
  plaintext: { line: [], block: [] },
};

const DEFAULT: Rules = C_LIKE;

export function rulesFor(languageId: string): Rules {
  return RULES[languageId] ?? DEFAULT;
}

/**
 * Procura, fora de strings, onde começa um comentário na linha.
 * Devolve o índice e, se for um bloco que não fecha nesta linha, o token de fechamento.
 */
function findComment(line: string, rules: Rules): { at: number; openBlock: string | null } | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    // Marcadores antes das aspas: docstrings (""") começam com aspas e não podem virar string.
    for (const m of rules.line) {
      if (line.startsWith(m, i)) return { at: i, openBlock: null };
    }
    let skipped = false;
    for (const [open, close] of rules.block) {
      if (line.startsWith(open, i)) {
        const end = line.indexOf(close, i + open.length);
        if (end < 0) return { at: i, openBlock: close };
        // bloco fecha na mesma linha: só conta como comentário se não houver código depois
        if (line.slice(end + close.length).trim() === '') return { at: i, openBlock: null };
        i = end + close.length - 1;
        skipped = true;
        break;
      }
    }
    if (skipped) continue;
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
  }
  return null;
}

export function requiredLengths(lines: string[], languageId: string): number[] {
  const rules = rulesFor(languageId);
  const out: number[] = [];
  let closing: string | null = null;

  for (const line of lines) {
    if (closing) {
      // dentro de um bloco de comentário: a linha inteira é pulada
      if (line.includes(closing)) closing = null;
      out.push(0);
      continue;
    }
    if (line.trim() === '') {
      out.push(0);
      continue;
    }
    const found = findComment(line, rules);
    if (!found) {
      out.push(line.length);
      continue;
    }
    if (found.openBlock) closing = found.openBlock;
    // o que vem antes do comentário, sem o espaço que o separa
    out.push(line.slice(0, found.at).trimEnd().length);
  }
  return out;
}
