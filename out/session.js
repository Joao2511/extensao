"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const vscode = require("vscode");
const comments_1 = require("./comments");
const fs = require("fs");
const os = require("os");
const path = require("path");
const STORAGE_KEY = 'aprender.sessions';
class SessionManager {
    ctx;
    sessions = new Map();
    pendingProposals = new Set();
    /** true enquanto a própria extensão edita o documento (evita auto-detecção do nosso próprio edit). */
    applying = false;
    ghostType;
    errorType;
    regionType;
    statusBar;
    toggleBar;
    constructor(ctx) {
        this.ctx = ctx;
        this.ghostType = vscode.window.createTextEditorDecorationType({
            after: {
                color: new vscode.ThemeColor('editorGhostText.foreground'),
                fontStyle: 'italic',
            },
        });
        this.errorType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('inputValidation.errorBorder'),
        });
        this.regionType = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
        });
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = 'aprender.reveal';
        this.toggleBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
        this.toggleBar.command = 'aprender.toggle';
        ctx.subscriptions.push(this.ghostType, this.errorType, this.regionType, this.statusBar, this.toggleBar, vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('aprender.enabled'))
                this.updateToggleBar();
            if (e.affectsConfiguration('aprender'))
                this.writeState();
        }));
        this.updateToggleBar();
        this.writeState();
        this.restore();
    }
    // ---------- ligar / desligar ----------
    get enabled() {
        return this.config.get('enabled', true);
    }
    /** Estado lido pelo hook do Claude Code (UserPromptSubmit) para saber se injeta a instrução de explicar. */
    writeState() {
        try {
            const dir = path.join(os.homedir(), '.aprender');
            fs.mkdirSync(dir, { recursive: true });
            const state = {
                enabled: this.enabled,
                explain: this.config.get('explainBeforeCode', true),
                explainText: this.config.get('explainText', ''),
                updatedAt: Date.now(),
            };
            fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
        }
        catch {
            /* sem permissão de escrita: o hook simplesmente não injeta nada */
        }
    }
    updateToggleBar() {
        if (this.enabled) {
            this.toggleBar.text = '$(pencil) Aprender: ligado';
            this.toggleBar.tooltip = 'Código da IA vira treino de digitação. Clique para desligar (revela todos os treinos).';
            this.toggleBar.backgroundColor = undefined;
        }
        else {
            this.toggleBar.text = '$(circle-slash) Aprender: desligado';
            this.toggleBar.tooltip = 'Código da IA é escrito normalmente. Clique para ligar.';
            this.toggleBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        this.toggleBar.show();
    }
    /** Alterna o modo. Ao desligar, escreve o código real em todos os treinos em andamento. */
    async toggle() {
        const next = !this.enabled;
        await this.config.update('enabled', next, vscode.ConfigurationTarget.Global);
        if (!next)
            await this.revealAll();
        vscode.window.setStatusBarMessage(next ? 'Aprender ligado.' : 'Aprender desligado: código revelado.', 3000);
    }
    /** Revela todos os treinos, inclusive em arquivos que não estão abertos no editor. */
    async revealAll() {
        for (const s of [...this.sessions.values()]) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(s.uri));
                if (doc.lineCount <= this.endLine(s))
                    continue;
                const range = new vscode.Range(s.startLine, 0, this.endLine(s), doc.lineAt(this.endLine(s)).text.length);
                const we = new vscode.WorkspaceEdit();
                we.replace(doc.uri, range, s.targetLines.join(this.eol(doc)));
                this.applying = true;
                await vscode.workspace.applyEdit(we);
                await doc.save();
            }
            catch {
                /* arquivo pode ter sido apagado; segue para o próximo */
            }
            finally {
                this.applying = false;
            }
            this.sessions.delete(s.uri);
        }
        this.persist();
        for (const ed of vscode.window.visibleTextEditors)
            this.clearDecorations(ed);
        this.setContext(false);
        this.statusBar.hide();
    }
    // ---------- persistência (o gabarito não pode se perder se o VS Code fechar) ----------
    persist() {
        void this.ctx.workspaceState.update(STORAGE_KEY, [...this.sessions.values()]);
    }
    restore() {
        const saved = this.ctx.workspaceState.get(STORAGE_KEY, []);
        for (const s of saved)
            this.sessions.set(s.uri, s);
    }
    // ---------- helpers ----------
    get config() {
        return vscode.workspace.getConfiguration('aprender');
    }
    sessionFor(doc) {
        return this.sessions.get(doc.uri.toString());
    }
    endLine(s) {
        return s.startLine + s.targetLines.length - 1;
    }
    inRegion(s, line) {
        return line >= s.startLine && line <= this.endLine(s);
    }
    eol(doc) {
        return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    }
    leadingWs(text) {
        return /^[ \t]*/.exec(text)[0];
    }
    async edit(editor, fn) {
        this.applying = true;
        try {
            await editor.edit(fn, { undoStopBefore: false, undoStopAfter: false });
        }
        finally {
            this.applying = false;
        }
    }
    setContext(active) {
        void vscode.commands.executeCommand('setContext', 'aprender.active', active);
    }
    // ---------- iniciar / encerrar ----------
    async startFromSelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const sel = editor.selection;
        if (sel.isEmpty) {
            vscode.window.showInformationMessage('Aprender: selecione o trecho de código que deseja treinar.');
            return;
        }
        // expande para linhas inteiras
        let endLine = sel.end.line;
        if (sel.end.character === 0 && endLine > sel.start.line)
            endLine--;
        const range = new vscode.Range(sel.start.line, 0, endLine, editor.document.lineAt(endLine).text.length);
        await this.startSession(editor, range);
    }
    async startSession(editor, range) {
        const doc = editor.document;
        if (this.sessionFor(doc)) {
            vscode.window.showWarningMessage('Aprender: este arquivo já tem um treino em andamento. Revele-o antes de iniciar outro.');
            return;
        }
        const target = doc.getText(range);
        const targetLines = target.split(/\r?\n/);
        if (targetLines.every((l) => l.trim() === ''))
            return;
        const session = {
            uri: doc.uri.toString(),
            startLine: range.start.line,
            targetLines,
            required: this.config.get('skipComments', true)
                ? (0, comments_1.requiredLengths)(targetLines, doc.languageId)
                : targetLines.map((l) => l.length),
            startedAt: Date.now(),
            keystrokes: 0,
            errors: 0,
        };
        this.warnFormatOnSave(doc);
        // Substitui o bloco por linhas vazias (mesma quantidade), para as decorações terem onde ancorar.
        await this.edit(editor, (b) => b.replace(range, this.eol(doc).repeat(targetLines.length - 1)));
        this.sessions.set(session.uri, session);
        this.persist();
        const first = this.nextIncomplete(editor, session, -1);
        if (first !== undefined)
            await this.enterLine(editor, session, first);
        this.render(editor);
    }
    required(s, idx) {
        return s.required?.[idx] ?? s.targetLines[idx].length;
    }
    /** Próxima linha depois de `after` que ainda precisa de digitação; undefined se não houver. */
    nextIncomplete(editor, s, after) {
        const doc = editor.document;
        for (let i = after + 1; i < s.targetLines.length; i++) {
            const lineNo = s.startLine + i;
            if (lineNo >= doc.lineCount)
                return undefined;
            const typed = doc.lineAt(lineNo).text;
            if (typed === s.targetLines[i])
                continue;
            if (this.required(s, i) === 0)
                continue; // comentário: será preenchido pelo render
            return i;
        }
        return undefined;
    }
    async reveal() {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const s = this.sessionFor(editor.document);
        if (!s)
            return;
        const doc = editor.document;
        const range = new vscode.Range(s.startLine, 0, this.endLine(s), doc.lineAt(this.endLine(s)).text.length);
        await this.edit(editor, (b) => b.replace(range, s.targetLines.join(this.eol(doc))));
        this.finish(editor, s, 'Aprender: treino encerrado, código revelado.');
    }
    finish(editor, s, msg) {
        this.sessions.delete(s.uri);
        this.persist();
        this.clearDecorations(editor);
        this.setContext(false);
        this.statusBar.hide();
        vscode.window.setStatusBarMessage(msg, 4000);
    }
    // ---------- motor de digitação ----------
    /** Substitui o comando `type` do editor. Devolve ao padrão quando não há treino no cursor. */
    async type(text) {
        const editor = vscode.window.activeTextEditor;
        const s = editor && this.sessionFor(editor.document);
        const cursor = editor?.selection.active;
        if (!editor || !s || !cursor || !this.inRegion(s, cursor.line)) {
            return vscode.commands.executeCommand('default:type', { text });
        }
        if (/\r?\n/.test(text)) {
            return this.handleEnter(editor, s, cursor.line);
        }
        const pos = editor.selection.active;
        const expected = s.targetLines[pos.line - s.startLine];
        const lineOk = editor.document.lineAt(pos.line).text === expected.slice(0, pos.character);
        s.keystrokes++;
        if (!lineOk || expected.slice(pos.character, pos.character + text.length) !== text)
            s.errors++;
        await this.edit(editor, (b) => b.insert(pos, text));
        this.render(editor);
    }
    /** Tab dentro do treino insere a indentação do editor, sem passar pelo auto-indent do VS Code. */
    async tab() {
        const editor = vscode.window.activeTextEditor;
        const s = editor && this.sessionFor(editor.document);
        const cursor = editor?.selection.active;
        if (!editor || !s || !cursor || !this.inRegion(s, cursor.line)) {
            return vscode.commands.executeCommand('tab');
        }
        const insertSpaces = editor.options.insertSpaces !== false;
        const size = Number(editor.options.tabSize ?? 4);
        return this.type(insertSpaces ? ' '.repeat(size) : '\t');
    }
    /** Colar/recortar dentro da região é bloqueado: quebraria a estrutura de linhas do treino. */
    async guardedCommand(command) {
        const editor = vscode.window.activeTextEditor;
        const s = editor && this.sessionFor(editor.document);
        const cursor = editor?.selection.active;
        if (editor && s && cursor && this.inRegion(s, cursor.line)) {
            vscode.window.setStatusBarMessage('Aprender: colar/recortar está desativado dentro do treino.', 2000);
            return;
        }
        return vscode.commands.executeCommand(command);
    }
    /** Delete nunca junta a linha atual com a próxima dentro da região. */
    async deleteRight() {
        const editor = vscode.window.activeTextEditor;
        const s = editor && this.sessionFor(editor.document);
        const cursor = editor?.selection.active;
        if (!editor || !s || !cursor || !this.inRegion(s, cursor.line)) {
            return vscode.commands.executeCommand('deleteRight');
        }
        const line = editor.document.lineAt(cursor.line);
        if (cursor.character >= line.text.length)
            return;
        await this.edit(editor, (b) => b.delete(new vscode.Range(cursor.line, cursor.character, cursor.line, cursor.character + 1)));
        this.render(editor);
    }
    warnedFormat = false;
    warnFormatOnSave(doc) {
        if (this.warnedFormat)
            return;
        const cfg = vscode.workspace.getConfiguration('editor', doc);
        if (cfg.get('formatOnSave')) {
            this.warnedFormat = true;
            void vscode.window
                .showWarningMessage('Aprender: "editor.formatOnSave" está ligado e pode reformatar as linhas parciais ao salvar. Desligar para este workspace?', 'Desligar', 'Manter')
                .then((c) => {
                if (c === 'Desligar')
                    void cfg.update('formatOnSave', false, vscode.ConfigurationTarget.Workspace);
            });
        }
    }
    stats(s) {
        const secs = Math.max(1, Math.round((Date.now() - s.startedAt) / 1000));
        const mm = String(Math.floor(secs / 60)).padStart(2, '0');
        const ss = String(secs % 60).padStart(2, '0');
        const acc = s.keystrokes === 0 ? 100 : Math.round(((s.keystrokes - s.errors) / s.keystrokes) * 100);
        return { time: `${mm}:${ss}`, acc, errors: s.errors, keystrokes: s.keystrokes };
    }
    async handleEnter(editor, s, line) {
        const idx = line - s.startLine;
        const typed = editor.document.lineAt(line).text;
        const expected = s.targetLines[idx];
        if (typed !== expected && typed !== expected.slice(0, this.required(s, idx))) {
            vscode.window.setStatusBarMessage('Aprender: complete a linha antes de avançar.', 1500);
            return;
        }
        const next = this.nextIncomplete(editor, s, idx);
        if (next !== undefined)
            await this.enterLine(editor, s, next);
        this.render(editor);
    }
    /** Move o cursor para a linha `idx` do treino e preenche a indentação, se configurado. */
    async enterLine(editor, s, idx) {
        const lineNo = s.startLine + idx;
        const doc = editor.document;
        const ws = this.leadingWs(s.targetLines[idx]);
        if (this.config.get('autoIndent', true) && ws && doc.lineAt(lineNo).text === '') {
            await this.edit(editor, (b) => b.insert(new vscode.Position(lineNo, 0), ws));
        }
        const end = doc.lineAt(lineNo).text.length;
        editor.selection = new vscode.Selection(lineNo, end, lineNo, end);
        editor.revealRange(new vscode.Range(lineNo, 0, lineNo, end));
    }
    async backspace() {
        const editor = vscode.window.activeTextEditor;
        const s = editor && this.sessionFor(editor.document);
        const cursor = editor?.selection.active;
        if (!editor || !s || !cursor || !this.inRegion(s, cursor.line)) {
            return vscode.commands.executeCommand('deleteLeft');
        }
        if (cursor.character > 0) {
            await this.edit(editor, (b) => b.delete(new vscode.Range(cursor.line, cursor.character - 1, cursor.line, cursor.character)));
        }
        else if (cursor.line > s.startLine) {
            // Nunca junta linhas (isso quebraria a região); só volta para o fim da linha anterior.
            const prev = cursor.line - 1;
            const end = editor.document.lineAt(prev).text.length;
            editor.selection = new vscode.Selection(prev, end, prev, end);
        }
        this.render(editor);
    }
    async skipLine() {
        const editor = vscode.window.activeTextEditor;
        const s = editor && this.sessionFor(editor.document);
        const cursor = editor?.selection.active;
        if (!editor || !s || !cursor || !this.inRegion(s, cursor.line))
            return;
        const idx = cursor.line - s.startLine;
        const lineRange = new vscode.Range(cursor.line, 0, cursor.line, editor.document.lineAt(cursor.line).text.length);
        await this.edit(editor, (b) => b.replace(lineRange, s.targetLines[idx]));
        if (idx < s.targetLines.length - 1)
            await this.enterLine(editor, s, idx + 1);
        this.render(editor);
    }
    // ---------- eventos ----------
    onDocChange(e) {
        const doc = e.document;
        const s = this.sessionFor(doc);
        const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
        if (s) {
            if (doc.lineCount <= this.endLine(s)) {
                // A região foi destruída (undo, colar multi-linha...). Abandona o treino para não corromper o arquivo.
                this.sessions.delete(s.uri);
                this.persist();
                if (editor)
                    this.clearDecorations(editor);
                this.setContext(false);
                this.statusBar.hide();
                vscode.window.showWarningMessage('Aprender: a região de treino foi alterada fora do fluxo; treino cancelado.');
                return;
            }
            if (editor)
                this.render(editor);
            return;
        }
        if (this.applying || !this.config.get('autoDetect', true))
            return;
        if (doc.uri.scheme !== 'file')
            return;
        const minLines = this.config.get('minLines', 3);
        for (const change of e.contentChanges) {
            const lines = change.text.split(/\r?\n/).length;
            if (lines >= minLines) {
                void this.propose(doc, change.range.start.line, change.range.start.line + lines - 1);
                break;
            }
        }
    }
    async propose(doc, startLine, endLine) {
        const key = doc.uri.toString();
        if (this.pendingProposals.has(key))
            return;
        this.pendingProposals.add(key);
        const version = doc.version;
        try {
            const choice = await vscode.window.showInformationMessage(`Aprender: ${endLine - startLine + 1} linhas novas em ${vscode.workspace.asRelativePath(doc.uri)}. Treinar esse bloco?`, 'Treinar', 'Ignorar');
            if (choice !== 'Treinar')
                return;
            if (doc.version !== version) {
                vscode.window.showWarningMessage('Aprender: o arquivo mudou desde a detecção. Selecione o trecho e use "Aprender: treinar seleção".');
                return;
            }
            const editor = await vscode.window.showTextDocument(doc);
            const last = Math.min(endLine, doc.lineCount - 1);
            await this.startSession(editor, new vscode.Range(startLine, 0, last, doc.lineAt(last).text.length));
        }
        finally {
            this.pendingProposals.delete(key);
        }
    }
    refresh() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.setContext(false);
            this.statusBar.hide();
            return;
        }
        const s = this.sessionFor(editor.document);
        if (s && editor.document.lineCount > this.endLine(s)) {
            this.render(editor);
        }
        else {
            this.clearDecorations(editor);
            this.setContext(false);
            this.statusBar.hide();
        }
    }
    // ---------- preenchimento automático (comentários) ----------
    filling = new Set();
    async fillLines(editor, s, idxs) {
        const pending = idxs.filter((i) => !this.filling.has(`${s.uri}:${i}`));
        if (!pending.length)
            return;
        for (const i of pending)
            this.filling.add(`${s.uri}:${i}`);
        try {
            const doc = editor.document;
            const cursorLine = editor.selection.active.line;
            await this.edit(editor, (b) => {
                for (const i of pending) {
                    const lineNo = s.startLine + i;
                    const range = new vscode.Range(lineNo, 0, lineNo, doc.lineAt(lineNo).text.length);
                    b.replace(range, s.targetLines[i]); // replace é idempotente, insert não
                }
            });
            // Se a linha do cursor foi completada, leva o cursor para o fim dela.
            const cursorIdx = cursorLine - s.startLine;
            if (pending.includes(cursorIdx)) {
                const end = doc.lineAt(cursorLine).text.length;
                editor.selection = new vscode.Selection(cursorLine, end, cursorLine, end);
            }
        }
        finally {
            for (const i of pending)
                this.filling.delete(`${s.uri}:${i}`);
        }
    }
    // ---------- renderização ----------
    clearDecorations(editor) {
        editor.setDecorations(this.ghostType, []);
        editor.setDecorations(this.errorType, []);
        editor.setDecorations(this.regionType, []);
    }
    visible(text, tabSize) {
        // Decorações colapsam espaços; usa NBSP para preservar alinhamento.
        return text.replace(/\t/g, ' '.repeat(tabSize)).replace(/ /g, ' ');
    }
    render(editor) {
        const s = this.sessionFor(editor.document);
        if (!s)
            return;
        const doc = editor.document;
        const tabSize = Number(editor.options.tabSize ?? 4);
        const ghosts = [];
        const errors = [];
        const toFill = [];
        let done = 0;
        s.targetLines.forEach((expected, i) => {
            const lineNo = s.startLine + i;
            const typed = doc.lineAt(lineNo).text;
            let p = 0;
            while (p < typed.length && p < expected.length && typed[p] === expected[p])
                p++;
            // Parte obrigatória digitada (o resto é comentário): preenche o restante sozinho.
            const req = this.required(s, i);
            if (typed !== expected && req < expected.length && typed === expected.slice(0, req)) {
                toFill.push(i);
            }
            if (typed === expected)
                done++;
            if (p < typed.length)
                errors.push(new vscode.Range(lineNo, p, lineNo, typed.length));
            const remaining = expected.slice(p);
            if (remaining) {
                const at = new vscode.Position(lineNo, typed.length);
                ghosts.push({
                    range: new vscode.Range(at, at),
                    renderOptions: { after: { contentText: this.visible(remaining, tabSize) } },
                });
            }
        });
        editor.setDecorations(this.ghostType, ghosts);
        editor.setDecorations(this.errorType, errors);
        editor.setDecorations(this.regionType, [new vscode.Range(s.startLine, 0, this.endLine(s), 0)]);
        this.setContext(true);
        this.persist();
        const st = this.stats(s);
        this.statusBar.text = `$(pencil) Aprender ${done}/${s.targetLines.length} · ${st.acc}% · ${st.errors} erros · ${st.time}`;
        this.statusBar.tooltip = 'Clique para revelar tudo e encerrar o treino';
        this.statusBar.show();
        if (toFill.length) {
            void this.fillLines(editor, s, toFill);
            return; // o edit dispara onDocChange, que renderiza de novo
        }
        if (done === s.targetLines.length) {
            this.finish(editor, s, `Aprender: bloco concluído. ${done} linhas, ${st.acc}% de precisão, ${st.errors} erros, ${st.time}.`);
            vscode.window.showInformationMessage(`Aprender: bloco concluído! ${done} linhas · ${st.acc}% de precisão · ${st.errors} erros · ${st.time}`);
        }
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=session.js.map