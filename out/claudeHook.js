"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeHookReceiver = void 0;
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const EVENTS_DIR = path.join(os.homedir(), '.aprender', 'events');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Observa ~/.aprender/events/*.json, gravados pelo hook PostToolUse do Claude Code.
 * A fila é global (uma para a máquina); cada janela do VS Code só consome os eventos
 * cujo arquivo pertence a um dos seus workspaces.
 */
class ClaudeHookReceiver {
    ctx;
    mgr;
    walk;
    out;
    log(msg) {
        this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
    }
    constructor(ctx, mgr, walk, out) {
        this.ctx = ctx;
        this.mgr = mgr;
        this.walk = walk;
        this.out = out;
        fs.mkdirSync(EVENTS_DIR, { recursive: true });
        this.log(`observando ${EVENTS_DIR}; workspaces: ${(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).join(', ') || '(nenhum)'}`);
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(EVENTS_DIR), '*.json'));
        watcher.onDidCreate((uri) => void this.consume(uri));
        watcher.onDidChange((uri) => void this.consume(uri));
        ctx.subscriptions.push(watcher);
        void this.drainExisting();
    }
    /** Eventos que chegaram enquanto o VS Code estava fechado. Descarta os muito antigos. */
    async drainExisting() {
        let names = [];
        try {
            names = fs.readdirSync(EVENTS_DIR).filter((n) => n.endsWith('.json'));
        }
        catch {
            return;
        }
        for (const n of names) {
            const full = path.join(EVENTS_DIR, n);
            try {
                if (Date.now() - fs.statSync(full).mtimeMs > MAX_AGE_MS) {
                    fs.unlinkSync(full);
                    continue;
                }
            }
            catch {
                continue;
            }
            await this.consume(vscode.Uri.file(full));
        }
    }
    ownsFile(filePath) {
        const target = path.resolve(filePath).toLowerCase();
        return (vscode.workspace.workspaceFolders ?? []).some((f) => {
            const root = path.resolve(f.uri.fsPath).toLowerCase();
            return target === root || target.startsWith(root + path.sep);
        });
    }
    async consume(uri) {
        let ev;
        try {
            ev = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
        }
        catch {
            return; // arquivo ainda sendo escrito ou inválido; o onDidChange tenta de novo
        }
        // Não é deste workspace: outra janela do VS Code cuida (ou o drain descarta depois de 24h).
        if (!this.ownsFile(ev.filePath)) {
            this.log(`evento ignorado (fora deste workspace): ${ev.filePath}`);
            return;
        }
        try {
            fs.unlinkSync(uri.fsPath);
        }
        catch {
            return; // outra janela pegou primeiro
        }
        this.log(`evento ${ev.tool}: ${ev.filePath} (modo ${this.mgr.mode})`);
        if (!this.mgr.enabled) {
            this.log('extensão desligada; código mantido como a IA escreveu');
            return;
        }
        let doc;
        try {
            doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ev.filePath));
        }
        catch {
            return;
        }
        const range = this.locate(doc, ev);
        if (!range) {
            this.log('bloco inserido não encontrado no arquivo; nada feito');
            return;
        }
        this.log(`bloco: linhas ${range.start.line + 1}-${range.end.line + 1}`);
        const mode = vscode.workspace.getConfiguration('aprender').get('claudeHook.autoStart', 'perguntar');
        if (mode === 'nunca')
            return;
        if (mode === 'perguntar') {
            const lines = range.end.line - range.start.line + 1;
            const choice = await vscode.window.showInformationMessage(`Aprender: o Claude Code escreveu ${lines} linhas em ${vscode.workspace.asRelativePath(doc.uri)}. Estudar?`, 'Estudar', 'Ignorar');
            if (choice !== 'Estudar')
                return;
        }
        const editor = await vscode.window.showTextDocument(doc);
        // Guarda o código antes de o treino apagar as linhas: a explicação é sobre ele, não sobre o fantasma.
        const code = this.mgr.realLines(doc, range.start.line, range.end.line);
        if (this.mgr.wantsTyping) {
            await this.mgr.startSession(editor, range);
            this.log('treino iniciado');
        }
        if (this.mgr.wantsExplain) {
            void this.walk.start(editor, range.start.line, code);
            this.log('explicação pedida');
        }
    }
    /** Encontra no documento o maior bloco que a IA inseriu e devolve o range em linhas inteiras. */
    locate(doc, ev) {
        if (ev.whole) {
            const last = doc.lineCount - 1;
            return new vscode.Range(0, 0, last, doc.lineAt(last).text.length);
        }
        const text = doc.getText();
        let best;
        for (const snippet of ev.inserted) {
            const idx = text.indexOf(snippet);
            if (idx < 0)
                continue;
            const start = doc.positionAt(idx);
            const end = doc.positionAt(idx + snippet.length);
            let endLine = end.line;
            if (end.character === 0 && endLine > start.line)
                endLine--;
            const r = new vscode.Range(start.line, 0, endLine, doc.lineAt(endLine).text.length);
            if (!best || r.end.line - r.start.line > best.end.line - best.start.line)
                best = r;
        }
        return best;
    }
    // ---------- instalação ----------
    /** Pergunta o escopo e grava o hook em ~/.claude/settings.json (global) ou <projeto>/.claude/settings.json. */
    async install() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const pick = await vscode.window.showQuickPick([
            {
                label: '$(globe) Em todos os projetos (recomendado)',
                detail: 'Grava em ~/.claude/settings.json. Faça isso uma vez só.',
                scope: 'global',
            },
            {
                label: '$(folder) Só neste projeto',
                detail: folder ? `Grava em ${folder.name}/.claude/settings.json` : 'Precisa de uma pasta aberta.',
                scope: 'project',
            },
        ], { placeHolder: 'Onde instalar o hook do Claude Code?' });
        if (!pick)
            return;
        if (pick.scope === 'project' && !folder) {
            vscode.window.showWarningMessage('Aprender: abra uma pasta de projeto para instalar o hook localmente.');
            return;
        }
        const settingsPath = pick.scope === 'global'
            ? path.join(os.homedir(), '.claude', 'settings.json')
            : path.join(folder.uri.fsPath, '.claude', 'settings.json');
        this.writeHook(settingsPath);
        this.out.show(true);
    }
    writeHook(settingsPath) {
        const scriptPath = path.join(this.ctx.extensionPath, 'hooks', 'claude-hook.js').replace(/\\/g, '/');
        const command = `node "${scriptPath}"`;
        let settings = {};
        if (fs.existsSync(settingsPath)) {
            try {
                settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            }
            catch {
                vscode.window.showErrorMessage(`Aprender: ${settingsPath} não é um JSON válido; corrija antes de instalar.`);
                return;
            }
        }
        settings.hooks ??= {};
        let before = 0;
        const upsert = (event, matcher) => {
            const list = settings.hooks[event] ?? [];
            before += list.length;
            // Remove versões antigas (ex.: caminho de outra versão da extensão) e grava a atual.
            const filtered = list.filter((h) => !JSON.stringify(h).includes('claude-hook.js'));
            const entry = { hooks: [{ type: 'command', command, timeout: 15 }] };
            if (matcher)
                entry.matcher = matcher;
            filtered.push(entry);
            settings.hooks[event] = filtered;
        };
        upsert('UserPromptSubmit', '');
        upsert('PreToolUse', 'Bash');
        upsert('PostToolUse', 'Edit|Write|MultiEdit|Bash');
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        vscode.window.showInformationMessage((before > 0 ? 'Aprender: hook atualizado em ' : 'Aprender: hook instalado em ') +
            `${settingsPath}. Reinicie o Claude Code para ele carregar.`);
    }
}
exports.ClaudeHookReceiver = ClaudeHookReceiver;
//# sourceMappingURL=claudeHook.js.map