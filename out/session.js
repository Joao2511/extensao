"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const vscode = require("vscode");
const comments_1 = require("./comments");
const agentRules_1 = require("./agentRules");
const challenge_1 = require("./challenge");
const fs = require("fs");
const os = require("os");
const path = require("path");
const STORAGE_KEY = 'aprender.sessions';
const MODE_LABEL = {
    digitar: { text: '$(pencil) Aprender: digitar', tip: 'Código da IA vira treino de digitação.' },
    explicar: { text: '$(book) Aprender: explicar', tip: 'Código fica normal, sem treino; só a explicação aparece.' },
    'digitar+explicar': {
        text: '$(mortar-board) Aprender: digitar + explicar',
        tip: 'Treino de digitação com a explicação de cada parte.',
    },
    desligado: { text: '$(circle-slash) Aprender: desligado', tip: 'Código da IA é escrito normalmente.' },
};
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
        // O fantasma é uma camada própria, como num teste de digitação: uma decoração por linha, na coluna 0,
        // com a linha alvo inteira e as colunas já digitadas em branco. `position: absolute` a tira do fluxo,
        // então o texto real é medido e desenhado como se ela não existisse e nada se desloca ao digitar.
        // (A API não tem campo para isso; `textDecoration` vai como CSS cru para a folha de estilo.)
        this.ghostType = vscode.window.createTextEditorDecorationType({
            before: {
                color: new vscode.ThemeColor('editorGhostText.foreground'),
                textDecoration: 'none; position: absolute; left: 0; top: 0; white-space: pre; pointer-events: none;',
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
            if (e.affectsConfiguration('aprender.mode') || e.affectsConfiguration('aprender.desafio.ligado')) {
                this.updateToggleBar();
            }
            if (e.affectsConfiguration('aprender'))
                this.writeState();
        }));
        this.migrateEnabled();
        this.updateToggleBar();
        this.writeState();
        this.restore();
    }
    // ---------- ligar / desligar ----------
    get mode() {
        return this.config.get('mode', 'digitar');
    }
    get enabled() {
        return this.mode !== 'desligado';
    }
    get wantsTyping() {
        return this.mode === 'digitar' || this.mode === 'digitar+explicar';
    }
    get wantsExplain() {
        return this.mode === 'explicar' || this.mode === 'digitar+explicar';
    }
    get challenge() {
        return this.config.get('desafio.ligado', false);
    }
    /** Liga/desliga o desafio. Vale para os próximos treinos; os em andamento continuam como começaram. */
    async toggleChallenge() {
        const next = !this.challenge;
        await this.config.update('desafio.ligado', next, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(next ? 'Aprender: desafio ligado — partes do código ficam escondidas no treino.' : 'Aprender: desafio desligado.', 3000);
    }
    /** Desafio: revela o trecho escondido sob o cursor (ou o próximo na linha). */
    revealHint() {
        const editor = vscode.window.activeTextEditor;
        const s = editor && this.sessionFor(editor.document);
        const cursor = editor?.selection.active;
        if (!editor || !s || !cursor || !this.inRegion(s, cursor.line))
            return;
        const ranges = s.hidden?.[cursor.line - s.startLine];
        if (!ranges?.length) {
            vscode.window.setStatusBarMessage('Aprender: nada escondido nesta linha.', 2000);
            return;
        }
        const at = ranges.findIndex(([, end]) => end > cursor.character);
        ranges.splice(at >= 0 ? at : 0, 1);
        this.persist();
        this.render(editor);
    }
    /** Versões antigas gravavam o booleano `aprender.enabled`; converte para `aprender.mode` uma vez. */
    migrateEnabled() {
        const old = this.config.inspect('enabled')?.globalValue;
        if (old === undefined)
            return;
        void this.config.update('enabled', undefined, vscode.ConfigurationTarget.Global);
        if (old === false && this.config.inspect('mode')?.globalValue === undefined) {
            void this.config.update('mode', 'desligado', vscode.ConfigurationTarget.Global);
        }
    }
    /** Estado lido pelo hook do Claude Code (UserPromptSubmit) para saber se injeta a instrução de explicar. */
    writeState() {
        try {
            const dir = path.join(os.homedir(), '.aprender');
            fs.mkdirSync(dir, { recursive: true });
            const state = {
                enabled: this.enabled,
                mode: this.mode,
                explain: this.config.get('explainBeforeCode', true),
                explainText: this.config.get('explainText', ''),
                updatedAt: Date.now(),
            };
            fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
        }
        catch {
            /* sem permissão de escrita: o hook simplesmente não injeta nada */
        }
        // Codex e Gemini não têm hook de prompt: a instrução vai no arquivo global de instruções deles.
        const others = this.enabled && this.config.get('explainBeforeCode', true) && this.config.get('explicar.outrasIAs', true)
            ? this.config.get('explainTextOutrasIAs', '')
            : '';
        (0, agentRules_1.syncAgentRules)(others);
    }
    updateToggleBar() {
        const { text, tip } = MODE_LABEL[this.mode] ?? MODE_LABEL.digitar;
        this.toggleBar.text = this.challenge && this.wantsTyping ? `${text} · desafio` : text;
        this.toggleBar.tooltip = `${tip} Clique para trocar o modo (Ctrl+Alt+T).`;
        this.toggleBar.backgroundColor = this.enabled ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
        this.toggleBar.show();
    }
    /** Pergunta o modo. Ao sair de um modo com digitação, escreve o código real em todos os treinos em andamento. */
    async chooseMode() {
        const items = Object.keys(MODE_LABEL).map((mode) => ({
            mode,
            label: MODE_LABEL[mode].text.replace('Aprender: ', ''),
            description: MODE_LABEL[mode].tip + (mode === this.mode ? ' · atual' : ''),
        }));
        items.push({ label: 'desafio', kind: vscode.QuickPickItemKind.Separator }, {
            challenge: true,
            label: this.challenge ? '$(eye-closed) Desafio: ligado' : '$(eye) Desafio: desligado',
            description: 'Esconde partes do código no treino; você deduz o que falta. Selecione para alternar.',
        });
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Como o Aprender deve tratar o código que a IA escrever?',
        });
        if (!pick)
            return;
        if (pick.challenge)
            await this.toggleChallenge();
        else if (pick.mode)
            await this.setMode(pick.mode);
    }
    async setMode(mode) {
        const hadTyping = this.wantsTyping;
        await this.config.update('mode', mode, vscode.ConfigurationTarget.Global);
        if (hadTyping && !this.wantsTyping)
            await this.revealAll();
        vscode.window.setStatusBarMessage(`Aprender: modo "${mode}".`, 3000);
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
    hasSession(doc) {
        return this.sessions.has(doc.uri.toString());
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
    /** Linhas `start..end` como código de verdade: dentro de um treino vem do gabarito, fora vem do editor. */
    realLines(doc, start, end) {
        const s = this.sessionFor(doc);
        const out = [];
        for (let i = start; i <= end && i < doc.lineCount; i++) {
            out.push(s && this.inRegion(s, i) ? s.targetLines[i - s.startLine] : doc.lineAt(i).text);
        }
        return out;
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
        const required = this.config.get('skipComments', true)
            ? (0, comments_1.requiredLengths)(targetLines, doc.languageId)
            : targetLines.map((l) => l.length);
        const session = {
            uri: doc.uri.toString(),
            startLine: range.start.line,
            targetLines,
            required,
            // Desafio: sorteia agora o que esconder e guarda junto do gabarito, para sobreviver a reload.
            hidden: this.challenge
                ? (0, challenge_1.chooseHidden)(targetLines, required, this.config.get('desafio.proporcao', 0.4))
                : undefined,
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
        const current = editor.document.lineAt(pos.line).text;
        const lineOk = current === expected.slice(0, pos.character);
        s.keystrokes++;
        if (!lineOk || expected.slice(pos.character, pos.character + text.length) !== text)
            s.errors++;
        // Sem await entre os dois: o edit e a decoração saem no mesmo tick e o editor repinta uma vez só.
        const applied = this.edit(editor, (b) => b.insert(pos, text));
        this.render(editor, {
            line: pos.line,
            text: current.slice(0, pos.character) + text + current.slice(pos.character),
        });
        await applied;
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
        const applied = this.edit(editor, (b) => b.delete(new vscode.Range(cursor.line, cursor.character, cursor.line, cursor.character + 1)));
        this.render(editor, {
            line: cursor.line,
            text: line.text.slice(0, cursor.character) + line.text.slice(cursor.character + 1),
        });
        await applied;
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
            const current = editor.document.lineAt(cursor.line).text;
            const applied = this.edit(editor, (b) => b.delete(new vscode.Range(cursor.line, cursor.character - 1, cursor.line, cursor.character)));
            this.render(editor, {
                line: cursor.line,
                text: current.slice(0, cursor.character - 1) + current.slice(cursor.character),
            });
            await applied;
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
    /**
     * Texto como o editor o desenha a partir da coluna `col`: tab avança até a próxima parada de tabulação
     * e espaço vira NBSP, porque decoração colapsa espaço comum. Assim a camada fantasma coincide com o texto real.
     */
    expand(text, col, tabSize) {
        let out = '';
        for (const ch of text) {
            if (ch === '\t') {
                const n = tabSize - (col % tabSize);
                out += ' '.repeat(n);
                col += n;
            }
            else {
                out += ch === ' ' ? ' ' : ch;
                col++;
            }
        }
        return out;
    }
    /**
     * Pinta as decorações do treino.
     *
     * `preview` diz como uma linha vai ficar depois de um edit que ainda está a caminho do editor.
     * Com ele a decoração nova viaja no mesmo tick do edit e o editor aplica os dois de uma vez;
     * sem ele havia um quadro intermediário em que o fantasma antigo aparecia uma casa à direita.
     * Nesse modo só pinta: o arquivo ainda não mudou, então quem preenche e conclui é o render real.
     */
    render(editor, preview) {
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
            const typed = preview && preview.line === lineNo ? preview.text : doc.lineAt(lineNo).text;
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
            // Fantasma alinhado por coluna: o que já foi digitado (certo ou errado) vira branco e o resto da
            // linha alvo continua no lugar. Assim ele nunca se move; só troca uma letra por vazio a cada tecla.
            // No desafio o fantasma mostra `_` nos trechos escondidos; a checagem acima continua contra o gabarito real.
            const remaining = (0, challenge_1.mask)(expected, s.hidden?.[i]).slice(typed.length);
            if (remaining) {
                const width = this.expand(typed, 0, tabSize).length;
                const at = new vscode.Position(lineNo, 0);
                ghosts.push({
                    range: new vscode.Range(at, at),
                    renderOptions: {
                        before: { contentText: ' '.repeat(width) + this.expand(remaining, width, tabSize) },
                    },
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
        // Estado previsto: o arquivo ainda não mudou, então não é hora de preencher linha nem de concluir.
        if (preview)
            return;
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