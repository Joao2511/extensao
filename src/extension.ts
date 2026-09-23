import * as vscode from 'vscode';
import { SessionManager } from './session';
import { ClaudeHookReceiver } from './claudeHook';
import { Walkthrough } from './walkthrough';
import { FileWatcher } from './watcher';

export function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Aprender');
  const mgr = new SessionManager(ctx);
  const walk = new Walkthrough(ctx, mgr, out);
  const hook = new ClaudeHookReceiver(ctx, mgr, walk, out);
  // Qualquer IA que escreva no disco (Codex, Gemini CLI, Aider...): não precisa de hook.
  new FileWatcher(ctx, hook, out);

  ctx.subscriptions.push(
    out,
    vscode.commands.registerCommand('aprender.start', () => mgr.startFromSelection()),
    vscode.commands.registerCommand('aprender.reveal', () => mgr.reveal()),
    vscode.commands.registerCommand('aprender.revealAll', () => mgr.revealAll()),
    vscode.commands.registerCommand('aprender.toggle', () => mgr.chooseMode()),
    vscode.commands.registerCommand('aprender.skipLine', () => mgr.skipLine()),
    vscode.commands.registerCommand('aprender.installClaudeHook', () => hook.install()),
    // Para IAs sem hook: copia a instrução de "explicar antes do código" para colar no arquivo de regras da IA.
    vscode.commands.registerCommand('aprender.copiarInstrucao', async () => {
      const text = vscode.workspace.getConfiguration('aprender').get<string>('explainTextOutrasIAs', '');
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(
        'Aprender: instrução copiada. Cole no arquivo de regras da sua IA (.github/copilot-instructions.md, .cursor/rules, .windsurf/rules, CONVENTIONS.md...).',
      );
    }),
    // Explicação parte por parte (Claude Code em modo -p, com a conta do usuário).
    vscode.commands.registerCommand('aprender.explicarSelecao', () => walk.explainSelection()),
    vscode.commands.registerCommand('aprender.escolherModelo', () => walk.chooseModel()),
    vscode.commands.registerCommand('aprender.escolherEffort', () => walk.chooseEffort()),
    vscode.commands.registerCommand('aprender.aprenderArquivo', () => walk.learnFile()),
    // Modo desafio: partes do código escondidas no treino.
    vscode.commands.registerCommand('aprender.desafio', () => mgr.toggleChallenge()),
    vscode.commands.registerCommand('aprender.revelarTrecho', () => mgr.revealHint()),
    vscode.commands.registerCommand('aprender.explicacao.proxima', () => walk.next()),
    vscode.commands.registerCommand('aprender.explicacao.anterior', () => walk.prev()),
    vscode.commands.registerCommand('aprender.explicacao.concluir', () => walk.finish()),
    // Teclas que precisam de tratamento especial dentro da região de treino.
    vscode.commands.registerCommand('aprender.backspace', () => mgr.backspace()),
    vscode.commands.registerCommand('aprender.delete', () => mgr.deleteRight()),
    vscode.commands.registerCommand('aprender.tab', () => mgr.tab()),
    vscode.commands.registerCommand('aprender.paste', () => mgr.guardedCommand('editor.action.clipboardPasteAction')),
    vscode.commands.registerCommand('aprender.cut', () => mgr.guardedCommand('editor.action.clipboardCutAction')),
    // Intercepta toda digitação no editor; devolve ao comportamento padrão fora de um treino.
    vscode.commands.registerCommand('type', (args: { text: string }) => mgr.type(args.text)),
    vscode.workspace.onDidChangeTextDocument((e) => mgr.onDocChange(e)),
    vscode.window.onDidChangeActiveTextEditor(() => mgr.refresh()),
  );

  mgr.refresh();
}

export function deactivate() {}
