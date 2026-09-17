#!/usr/bin/env node
// Hook do Claude Code usado pela extensão Aprender.
//   PreToolUse  (Bash)                    -> marca o instante em que o comando começou
//   PostToolUse (Edit|Write|MultiEdit)    -> evento com o texto inserido
//   PostToolUse (Bash)                    -> procura arquivos modificados desde a marca (cat > x, tee, scripts...)
// Grava eventos em ~/.aprender/events/, que a extensão observa. Nunca falha (sai sempre com 0).

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = path.join(os.homedir(), '.aprender');
const EVENTS = path.join(BASE, 'events');
const MARK = path.join(BASE, 'bash-start');
const STATE = path.join(BASE, 'state.json'); // gravado pela extensão: { enabled, explain, explainText }
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'coverage', '.aprender', '.claude', 'vendor', '__pycache__', '.venv', 'venv']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.mp4', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.exe', '.dll', '.so', '.db', '.sqlite', '.lock']);

function emit(payload) {
  fs.mkdirSync(EVENTS, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(EVENTS, name), JSON.stringify({ ...payload, at: Date.now() }));
}

/** Arquivos de texto sob `root` modificados a partir de `since` (ms). Limitado em profundidade e quantidade. */
function modifiedSince(root, since, maxDepth = 8, limit = 20) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile()) {
        if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= since && st.size > 0 && st.size < 1024 * 1024) found.push(full);
        } catch {
          /* ignora */
        }
      }
    }
  };
  walk(root, 0);
  return found;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw);
    const input = ev.tool_input || {};
    const cwd = ev.cwd || process.cwd();
    const tool = ev.tool_name;
    const phase = ev.hook_event_name; // "UserPromptSubmit" | "PreToolUse" | "PostToolUse"

    // A cada prompt: se a extensão estiver ligada, injeta a instrução de explicar antes de codar.
    if (phase === 'UserPromptSubmit') {
      let state = null;
      try {
        state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      } catch {
        return; // extensão nunca rodou nesta máquina
      }
      if (state && state.enabled && state.explain && state.explainText) {
        process.stdout.write(String(state.explainText));
      }
      return;
    }

    if (tool === 'Bash') {
      if (phase === 'PreToolUse') {
        fs.mkdirSync(BASE, { recursive: true });
        fs.writeFileSync(MARK, String(Date.now()));
        return;
      }
      // PostToolUse: qualquer arquivo tocado desde a marca (tolerância de 2s para relógio de disco)
      let since = Date.now() - 60 * 1000;
      try {
        since = Number(fs.readFileSync(MARK, 'utf8')) - 2000;
      } catch {
        /* sem marca: usa último minuto */
      }
      for (const filePath of modifiedSince(cwd, since)) {
        emit({ tool: 'Bash', filePath, inserted: [], whole: true });
      }
      return;
    }

    let filePath = input.file_path;
    if (!filePath) return;
    if (!path.isAbsolute(filePath)) filePath = path.resolve(cwd, filePath);

    let inserted = [];
    if (tool === 'Write') inserted = [input.content || ''];
    else if (tool === 'Edit') inserted = [input.new_string || ''];
    else if (tool === 'MultiEdit') inserted = (input.edits || []).map((e) => e.new_string || '');
    inserted = inserted.filter((t) => t.trim() !== '');
    if (inserted.length === 0) return;

    emit({ tool, filePath, inserted, whole: tool === 'Write' });
  } catch {
    // silencioso: um hook quebrado não pode atrapalhar o Claude Code
  }
});
