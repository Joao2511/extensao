import * as vscode from 'vscode';
import { SessionManager } from './session';
import { ClaudeHookReceiver } from './claudeHook';

export function activate(ctx: vscode.ExtensionContext) {
  const mgr = new SessionManager(ctx);
  const hook = new ClaudeHookReceiver(ctx, mgr);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('aprender.start', () => mgr.startFromSelection()),
    vscode.commands.registerCommand('aprender.reveal', () => mgr.reveal()),
    vscode.commands.registerCommand('aprender.revealAll', () => mgr.revealAll()),
    vscode.commands.registerCommand('aprender.toggle', () => mgr.toggle()),
    vscode.commands.registerCommand('aprender.skipLine', () => mgr.skipLine()),
    vscode.commands.registerCommand('aprender.installClaudeHook', () => hook.install()),
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
