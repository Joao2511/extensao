import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeHookReceiver } from './claudeHook';

/**
 * Observa os arquivos do projeto e trata como "escrito pela IA" todo arquivo alterado no disco
 * por outro programa (Codex, Gemini CLI, Aider, OpenCode, Claude Code...). Não depende de hook.
 *
 * Como sabe o que mudou: guarda uma cópia do conteúdo de cada arquivo de texto do projeto e,
 * quando o disco muda, compara linha a linha. O trecho entre o início e o fim iguais vira o treino.
 *
 * O que ignora: salvamentos feitos pelo próprio VS Code (você digitando), pastas de build e
 * dependências, arquivos binários ou grandes, e rajadas de muitos arquivos de uma vez (git, npm).
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'coverage', '.aprender',
  '.claude', '.codex', '.gemini', '.cursor', 'vendor', '__pycache__', '.venv', 'venv', '.gradle', '.idea',
  '.vscode-test', 'obj',
]);
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz', '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.mp4', '.mov', '.mp3', '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.exe', '.dll', '.so',
  '.dylib', '.class', '.jar', '.pyc', '.db', '.sqlite', '.lock', '.vsix', '.map',
]);
const EXCLUDE_GLOB = `{${[...SKIP_DIRS].map((d) => `**/${d}/**`).join(',')}}`;
const MAX_BYTES = 512 * 1024;
const MAX_SNAPSHOT_FILES = 5000;
/** Mais arquivos que isso mudando juntos = git, instalação de pacotes, gerador de código: não é para estudar. */
const MAX_BURST = 10;
const DEBOUNCE_MS = 600;
/** Mudança no disco logo depois de o VS Code salvar o arquivo é o salvamento, não a IA. */
const SAVE_GRACE_MS = 2000;
const HOME_APRENDER = path.join(os.homedir(), '.aprender');

export class FileWatcher {
  private snapshot = new Map<string, string>();
  private savedAt = new Map<string, number>();
  private pending = new Map<string, boolean>(); // caminho -> foi criado agora
  private timer?: NodeJS.Timeout;

  constructor(
    ctx: vscode.ExtensionContext,
    private receiver: ClaudeHookReceiver,
    private out: vscode.OutputChannel,
  ) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      w.onDidCreate((u) => this.queue(u, true));
      w.onDidChange((u) => this.queue(u, false));
      w.onDidDelete((u) => this.snapshot.delete(this.key(u.fsPath)));
      ctx.subscriptions.push(w);
    }
    ctx.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((d) => this.savedAt.set(this.key(d.uri.fsPath), Date.now())),
      // Arquivos além do limite inicial entram na cópia quando são abertos.
      vscode.workspace.onDidOpenTextDocument((d) => {
        if (d.uri.scheme === 'file' && !this.snapshot.has(this.key(d.uri.fsPath))) void this.remember(d.uri.fsPath);
      }),
      { dispose: () => this.timer && clearTimeout(this.timer) },
    );
    void this.buildSnapshot();
  }

  private get on() {
    return vscode.workspace.getConfiguration('aprender').get<boolean>('observarArquivos', true);
  }

  private log(msg: string) {
    this.out.appendLine(`[${new Date().toLocaleTimeString()}] [arquivos] ${msg}`);
  }

  /** Windows e macOS não diferenciam maiúsculas nos caminhos; o Linux diferencia. */
  private key(p: string) {
    const r = path.resolve(p);
    return process.platform === 'linux' ? r : r.toLowerCase();
  }

  private ignored(p: string) {
    if (this.key(p).startsWith(this.key(HOME_APRENDER))) return true;
    // Só as pastas dentro do projeto contam: um projeto em D:\build\app não pode ser ignorado inteiro.
    const parts = vscode.workspace.asRelativePath(p, false).split(/[\\/]/);
    if (parts.some((seg) => SKIP_DIRS.has(seg))) return true;
    const base = parts[parts.length - 1];
    return SKIP_FILES.has(base) || BINARY_EXT.has(path.extname(base).toLowerCase());
  }

  private async read(p: string): Promise<string | undefined> {
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.size > MAX_BYTES) return undefined;
      const text = await fs.promises.readFile(p, 'utf8');
      return text.includes('\u0000') ? undefined : text; // binário disfarçado
    } catch {
      return undefined;
    }
  }

  private async remember(p: string) {
    if (this.ignored(p)) return;
    const text = await this.read(p);
    if (text !== undefined) this.snapshot.set(this.key(p), text);
  }

  private async buildSnapshot() {
    const t0 = Date.now();
    const files = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_SNAPSHOT_FILES);
    for (let i = 0; i < files.length; i += 50) {
      await Promise.all(files.slice(i, i + 50).map((u) => this.remember(u.fsPath)));
    }
    this.log(`cópia de referência pronta: ${this.snapshot.size} arquivos em ${Date.now() - t0} ms`);
  }

  private queue(uri: vscode.Uri, created: boolean) {
    if (this.ignored(uri.fsPath)) return;
    this.pending.set(uri.fsPath, created || (this.pending.get(uri.fsPath) ?? false));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  private async flush() {
    const batch = [...this.pending];
    this.pending.clear();
    if (batch.length > MAX_BURST) {
      this.log(`${batch.length} arquivos mudaram juntos (git, instalação?); nada para estudar`);
      await Promise.all(batch.map(([p]) => this.remember(p)));
      return;
    }
    for (const [p, created] of batch) await this.handle(p, created);
  }

  private async handle(p: string, created: boolean) {
    const k = this.key(p);
    const now = await this.read(p);
    if (now === undefined) return;
    const before = this.snapshot.get(k);
    this.snapshot.set(k, now);

    if (Date.now() - (this.savedAt.get(k) ?? 0) < SAVE_GRACE_MS) return; // foi o VS Code salvando
    if (!this.on) return;
    if (before === now) return;
    if (before === undefined && !created) {
      this.log(`sem versão anterior de ${vscode.workspace.asRelativePath(p)}; ignorado`);
      return;
    }

    const block = changedBlock(before ?? '', now);
    if (!block) return;

    const uri = vscode.Uri.file(p);
    const doc = await this.synced(uri, now);
    if (!doc) {
      this.log(`${vscode.workspace.asRelativePath(p)} tem alterações não salvas no editor; ignorado`);
      return;
    }
    const end = Math.min(block.end, doc.lineCount - 1);
    await this.receiver.study(doc, new vscode.Range(block.start, 0, end, doc.lineAt(end).text.length), 'a IA');
  }

  /** Espera o VS Code recarregar o arquivo do disco (se estiver aberto) para as linhas baterem. */
  private async synced(uri: vscode.Uri, disk: string): Promise<vscode.TextDocument | undefined> {
    const norm = (t: string) => t.replace(/\r\n/g, '\n');
    const target = norm(disk);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (norm(doc.getText()) === target) return doc;
    if (doc.isDirty) return undefined;
    return new Promise((resolve) => {
      const done = (d: vscode.TextDocument | undefined) => {
        sub.dispose();
        clearTimeout(t);
        resolve(d);
      };
      const sub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === doc && norm(doc.getText()) === target) done(doc);
      });
      const t = setTimeout(() => done(norm(doc.getText()) === target ? doc : undefined), 3000);
    });
  }
}

/**
 * Linhas novas entre o começo e o fim que não mudaram. Undefined se só houve remoção ou espaço em branco.
 * Exportada para teste.
 */
export function changedBlock(before: string, after: string): { start: number; end: number } | undefined {
  const a = before === '' ? [] : before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  let start = prefix;
  let end = b.length - 1 - suffix;
  // Linhas em branco nas pontas não são código para digitar.
  while (start <= end && b[start].trim() === '') start++;
  while (end >= start && b[end].trim() === '') end--;
  return start <= end ? { start, end } : undefined;
}
