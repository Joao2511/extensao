"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeHookReceiver = void 0;
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const platform_1 = require("./platform");
const BASE_DIR = path.join(os.homedir(), '.aprender');
const EVENTS_DIR = path.join(BASE_DIR, 'events');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Cópia do script do hook num caminho que não muda entre versões da extensão nem entre sistemas. */
const HOOK_SCRIPT = path.join(BASE_DIR, 'claude-hook.js');
const HOOK_COMMAND = `node "${HOOK_SCRIPT.replace(/\\/g, '/')}"`;
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
        this.syncHookScript();
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
        await this.study(doc, range, 'o Claude Code');
    }
    /**
     * Transforma um bloco escrito pela IA em estudo (treino e/ou explicação, conforme o modo).
     * Usado pelo hook do Claude Code e pelo observador de arquivos (qualquer IA).
     */
    async study(doc, range, who) {
        if (!this.mgr.enabled)
            return;
        if (this.mgr.hasSession(doc)) {
            // Hook e observador podem avisar do mesmo arquivo; o primeiro a chegar vence.
            this.log(`já há treino em ${vscode.workspace.asRelativePath(doc.uri)}; bloco ignorado`);
            return;
        }
        this.log(`bloco de ${who}: linhas ${range.start.line + 1}-${range.end.line + 1} em ${vscode.workspace.asRelativePath(doc.uri)}`);
        const mode = vscode.workspace.getConfiguration('aprender').get('claudeHook.autoStart', 'perguntar');
        if (mode === 'nunca')
            return;
        if (mode === 'perguntar') {
            const lines = range.end.line - range.start.line + 1;
            const choice = await vscode.window.showInformationMessage(`Aprender: ${who} escreveu ${lines} linhas em ${vscode.workspace.asRelativePath(doc.uri)}. Estudar?`, 'Estudar', 'Ignorar');
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
        this.syncHookScript();
        this.writeHook(settingsPath);
        this.out.show(true);
        const node = await (0, platform_1.nodeVersion)();
        this.log(node ? `node encontrado: ${node}` : 'node NÃO encontrado no PATH');
        if (!node) {
            vscode.window.showWarningMessage('Aprender: o Node.js não foi encontrado. O hook do Claude Code roda com "node"; instale o Node.js (nodejs.org) e reinicie o Claude Code.');
        }
    }
    /**
     * Copia o script do hook para ~/.aprender/ a cada ativação (assim atualizações da extensão chegam ao hook)
     * e corrige instalações antigas que apontavam para a pasta versionada da extensão.
     */
    syncHookScript() {
        try {
            fs.copyFileSync(path.join(this.ctx.extensionPath, 'hooks', 'claude-hook.js'), HOOK_SCRIPT);
        }
        catch (e) {
            this.log(`não consegui copiar o script do hook: ${e instanceof Error ? e.message : e}`);
            return;
        }
        const candidates = [
            path.join(os.homedir(), '.claude', 'settings.json'),
            ...(vscode.workspace.workspaceFolders ?? []).map((f) => path.join(f.uri.fsPath, '.claude', 'settings.json')),
        ];
        for (const file of candidates) {
            let text;
            try {
                text = fs.readFileSync(file, 'utf8');
            }
            catch {
                continue;
            }
            if (!text.includes('claude-hook.js'))
                continue; // hook nunca instalado aqui: não mexe
            try {
                const settings = JSON.parse(text);
                let changed = false;
                for (const list of Object.values(settings.hooks ?? {})) {
                    for (const entry of list ?? []) {
                        for (const h of entry?.hooks ?? []) {
                            if (typeof h.command === 'string' && h.command.includes('claude-hook.js') && h.command !== HOOK_COMMAND) {
                                h.command = HOOK_COMMAND;
                                changed = true;
                            }
                        }
                    }
                }
                if (changed) {
                    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
                    this.log(`hook atualizado para o caminho fixo em ${file}`);
                }
            }
            catch {
                /* JSON inválido: deixa como está */
            }
        }
    }
    writeHook(settingsPath) {
        const command = HOOK_COMMAND;
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