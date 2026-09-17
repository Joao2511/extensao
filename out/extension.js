"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const session_1 = require("./session");
const claudeHook_1 = require("./claudeHook");
function activate(ctx) {
    const mgr = new session_1.SessionManager(ctx);
    const hook = new claudeHook_1.ClaudeHookReceiver(ctx, mgr);
    ctx.subscriptions.push(vscode.commands.registerCommand('aprender.start', () => mgr.startFromSelection()), vscode.commands.registerCommand('aprender.reveal', () => mgr.reveal()), vscode.commands.registerCommand('aprender.revealAll', () => mgr.revealAll()), vscode.commands.registerCommand('aprender.toggle', () => mgr.toggle()), vscode.commands.registerCommand('aprender.skipLine', () => mgr.skipLine()), vscode.commands.registerCommand('aprender.installClaudeHook', () => hook.install()), 
    // Teclas que precisam de tratamento especial dentro da região de treino.
    vscode.commands.registerCommand('aprender.backspace', () => mgr.backspace()), vscode.commands.registerCommand('aprender.delete', () => mgr.deleteRight()), vscode.commands.registerCommand('aprender.tab', () => mgr.tab()), vscode.commands.registerCommand('aprender.paste', () => mgr.guardedCommand('editor.action.clipboardPasteAction')), vscode.commands.registerCommand('aprender.cut', () => mgr.guardedCommand('editor.action.clipboardCutAction')), 
    // Intercepta toda digitação no editor; devolve ao comportamento padrão fora de um treino.
    vscode.commands.registerCommand('type', (args) => mgr.type(args.text)), vscode.workspace.onDidChangeTextDocument((e) => mgr.onDocChange(e)), vscode.window.onDidChangeActiveTextEditor(() => mgr.refresh()));
    mgr.refresh();
}
function deactivate() { }
//# sourceMappingURL=extension.js.map