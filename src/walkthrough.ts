import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Explainer, Part } from './explainer';
import { SessionManager } from './session';

/** Uma explicação em andamento num documento: as partes, o cartão de cada uma e qual está aberta. */
interface Tour {
  startLine: number;
  parts: Part[];
  threads: vscode.CommentThread[];
  current: number;
}

/**
 * Mostra a explicação parte por parte dentro do próprio editor, com a API de comentários do VS Code:
 * cada parte vira um cartão preso às suas linhas, com botões de anterior/próxima/concluir no cabeçalho.
 * Só a parte atual fica aberta; as outras ficam recolhidas e abrem quando o cursor entra nelas.
 */
export class Walkthrough {
  private controller = vscode.comments.createCommentController('aprender', 'Aprender');
  private tours = new Map<string, Tour>();
  private explainer?: Explainer;
  private highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('focusBorder'),
  });
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);

  constructor(ctx: vscode.ExtensionContext, private mgr: SessionManager, private out: vscode.OutputChannel) {
    ctx.subscriptions.push(
      this.controller,
      this.highlight,
      this.status,
      vscode.window.onDidChangeTextEditorSelection((e) => this.followCursor(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((ed) => ed && this.paint(ed)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc.uri.toString())),
    );
  }

  private get config() {
    return vscode.workspace.getConfiguration('aprender');
  }

  /** O binário que o próprio Claude Code do VS Code usa; assim o login e a cota são os da conta. */
  private findBinary(): string {
    const custom = this.config.get<string>('explicar.caminhoDoClaude', '').trim();
    if (custom) return custom;
    const ext = vscode.extensions.getExtension('Anthropic.claude-code');
    if (ext) {
      for (const name of ['claude', 'claude.exe']) {
        const candidate = path.join(ext.extensionPath, 'resources', 'native-binary', name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return 'claude'; // último recurso: o que estiver no PATH
  }

  /** Explica `lines` (o código de verdade, mesmo que o editor só mostre o fantasma) a partir da linha `startLine`. */
  async start(editor: vscode.TextEditor, startLine: number, lines: string[]) {
    const doc = editor.document;
    const key = doc.uri.toString();
    this.clear(key);
    if (!lines.some((l) => l.trim())) return;

    this.explainer?.cancel();
    const explainer = new Explainer(this.findBinary());
    this.explainer = explainer;
    const model = this.config.get<string>('explicar.modelo', 'sonnet').trim() || 'sonnet';
    const effortCfg = this.config.get<string>('explicar.effort', 'padrão').trim();
    const effort = effortCfg && effortCfg !== 'padrão' ? effortCfg : undefined;
    const t0 = Date.now();
    this.out.appendLine(`explicação pedida: ${lines.length} linhas, modelo ${model}${effort ? `, effort ${effort}` : ''}`);

    let cancelled = false;
    let parts: Part[];
    try {
      // Notificação com spinner e botão de cancelar; a barra de status também mostra o andamento.
      parts = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Aprender: pedindo a explicação ao Claude (${model})…`,
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            cancelled = true;
            explainer.cancel();
          });
          this.status.text = '$(sync~spin) Aprender: explicando…';
          this.status.show();
          try {
            return await explainer.explain({
              lines,
              language: doc.languageId,
              fileName: path.basename(doc.fileName),
              model,
              effort,
            });
          } finally {
            this.status.hide();
          }
        },
      );
    } catch (e) {
      if (cancelled || this.explainer !== explainer) {
        this.out.appendLine('explicação cancelada');
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.out.appendLine(`explicação falhou após ${Date.now() - t0} ms: ${msg}`);
      vscode.window.showErrorMessage(`Aprender: não consegui a explicação. ${msg}`);
      return;
    }
    if (this.explainer !== explainer) return; // outro pedido começou enquanto este esperava
    this.out.appendLine(`explicação pronta em ${Date.now() - t0} ms: ${parts.length} partes`);

    // O editor de antes pode ter sido descartado enquanto esperávamos (troca de aba); usa o que mostra o documento agora.
    const live = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === key) ?? editor;
    const threads = parts.map((p, i) => {
      const thread = this.controller.createCommentThread(doc.uri, this.rangeOf(doc, startLine, p), [
        {
          body: new vscode.MarkdownString(`**${p.title}**\n\n${p.explanation}`),
          mode: vscode.CommentMode.Preview,
          author: { name: 'Aprender' },
        },
      ]);
      thread.label = `Parte ${i + 1} de ${parts.length}`;
      thread.contextValue = 'aprender';
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      return thread;
    });
    this.tours.set(key, { startLine, parts, threads, current: -1 });
    this.show(live, 0, true);
  }

  /** Comando manual: explica a seleção, ou o arquivo inteiro se não houver seleção. */
  async explainSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const sel = editor.selection;
    let start = sel.start.line;
    let end = sel.end.line;
    if (sel.isEmpty) {
      start = 0;
      end = doc.lineCount - 1;
    } else if (sel.end.character === 0 && end > start) {
      end--;
    }
    await this.start(editor, start, this.mgr.realLines(doc, start, end));
  }

  /** Comando "aprender arquivo": o código já escrito vira treino de digitação e ganha a explicação por partes. */
  async learnFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const sel = editor.selection;
    let start = 0;
    let end = doc.lineCount - 1;
    if (!sel.isEmpty) {
      start = sel.start.line;
      end = sel.end.character === 0 && sel.end.line > start ? sel.end.line - 1 : sel.end.line;
    }
    const code = this.mgr.realLines(doc, start, end);
    if (!code.some((l) => l.trim())) return;
    await this.mgr.startSession(editor, new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
    await this.start(editor, start, code);
  }

  /** Comando: escolhe o modelo da explicação sem abrir as configurações. Grava em `aprender.explicar.modelo`. */
  async chooseModel() {
    const current = this.config.get<string>('explicar.modelo', 'sonnet');
    const items: vscode.QuickPickItem[] = [
      { label: 'haiku', description: 'mais rápido; explicações mais curtas' },
      { label: 'sonnet', description: 'equilíbrio entre qualidade e tempo (padrão)' },
      { label: 'opus', description: 'mais capaz; mais lento' },
      { label: 'Outro…', description: 'digitar o nome completo de um modelo' },
    ].map((i) => (i.label === current ? { ...i, description: `${i.description} · atual` } : i));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Modelo atual: ${current}` });
    if (!pick) return;
    let model = pick.label;
    if (model === 'Outro…') {
      const typed = await vscode.window.showInputBox({ prompt: 'Nome do modelo', value: current });
      if (!typed?.trim()) return;
      model = typed.trim();
    }
    await this.config.update('explicar.modelo', model, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Aprender: explicações com "${model}".`, 3000);
  }

  /** Comando: escolhe o esforço (`--effort`) da explicação. Mais esforço = mais demora e, em geral, mais cuidado. */
  async chooseEffort() {
    const current = this.config.get<string>('explicar.effort', 'padrão');
    const items: vscode.QuickPickItem[] = [
      { label: 'padrão', description: 'deixa o Claude decidir' },
      { label: 'low', description: 'mais rápido' },
      { label: 'medium', description: '' },
      { label: 'high', description: '' },
      { label: 'xhigh', description: '' },
      { label: 'max', description: 'mais demorado' },
    ].map((i) => (i.label === current ? { ...i, description: `${i.description} · atual`.replace(/^ · /, '') } : i));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Esforço atual: ${current}` });
    if (!pick) return;
    await this.config.update('explicar.effort', pick.label, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Aprender: esforço da explicação "${pick.label}".`, 3000);
  }

  next() {
    this.step(1);
  }

  prev() {
    this.step(-1);
  }

  finish() {
    const editor = vscode.window.activeTextEditor;
    if (editor) this.clear(editor.document.uri.toString());
  }

  private step(delta: number) {
    const editor = vscode.window.activeTextEditor;
    const tour = editor && this.tours.get(editor.document.uri.toString());
    if (!editor || !tour) return;
    this.show(editor, tour.current + delta, true);
  }

  private rangeOf(doc: vscode.TextDocument, startLine: number, p: Part) {
    const last = Math.min(doc.lineCount - 1, startLine + p.endLine - 1);
    const first = Math.min(last, startLine + p.startLine - 1);
    return new vscode.Range(first, 0, last, doc.lineAt(last).text.length);
  }

  private show(editor: vscode.TextEditor, index: number, reveal: boolean) {
    const tour = this.tours.get(editor.document.uri.toString());
    if (!tour || index < 0 || index >= tour.parts.length) return;
    tour.current = index;
    tour.threads.forEach((t, i) => {
      t.collapsibleState =
        i === index ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
    });
    this.paint(editor);
    if (reveal) {
      editor.revealRange(
        this.rangeOf(editor.document, tour.startLine, tour.parts[index]),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }
  }

  private paint(editor: vscode.TextEditor) {
    const tour = this.tours.get(editor.document.uri.toString());
    if (!tour || tour.current < 0) {
      editor.setDecorations(this.highlight, []);
      return;
    }
    editor.setDecorations(this.highlight, [this.rangeOf(editor.document, tour.startLine, tour.parts[tour.current])]);
  }

  /** Ao mover o cursor para dentro de outra parte (ex.: o treino avançou de linha), abre o cartão dela. */
  private followCursor(editor: vscode.TextEditor) {
    const tour = this.tours.get(editor.document.uri.toString());
    if (!tour) return;
    const line = editor.selection.active.line - tour.startLine + 1;
    const idx = tour.parts.findIndex((p) => line >= p.startLine && line <= p.endLine);
    if (idx >= 0 && idx !== tour.current) this.show(editor, idx, false);
  }

  private clear(key: string) {
    const tour = this.tours.get(key);
    if (!tour) return;
    for (const t of tour.threads) t.dispose();
    this.tours.delete(key);
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() === key) ed.setDecorations(this.highlight, []);
    }
  }
}
