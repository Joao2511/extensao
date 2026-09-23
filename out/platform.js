"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findExecutable = findExecutable;
exports.resolveClaude = resolveClaude;
exports.runFile = runFile;
exports.killTree = killTree;
exports.nodeVersion = nodeVersion;
const child_process_1 = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
/**
 * Diferenças entre Windows, macOS e Linux concentradas num lugar só:
 * achar o executável do Claude Code, rodar CLIs instaladas pelo npm (.cmd no Windows) e matar processos.
 */
const isWin = process.platform === 'win32';
function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}
/** Nomes de executável possíveis para `base` neste sistema. */
function exeNames(base) {
    return isWin ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base] : [base];
}
/** Procura `base` nas pastas do PATH e em pastas conhecidas (o VS Code aberto pelo menu não herda o PATH do terminal). */
function findExecutable(base, extraDirs = []) {
    const home = os.homedir();
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const known = isWin
        ? [
            path.join(home, '.local', 'bin'),
            path.join(home, '.claude', 'local'),
            path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'),
            path.join(home, '.bun', 'bin'),
            path.join(home, 'scoop', 'shims'),
        ]
        : [
            path.join(home, '.local', 'bin'),
            path.join(home, '.claude', 'local'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
            path.join(home, '.npm-global', 'bin'),
            path.join(home, '.bun', 'bin'),
            path.join(home, '.volta', 'bin'),
        ];
    for (const dir of [...extraDirs, ...pathDirs, ...known]) {
        for (const name of exeNames(base)) {
            const full = path.join(dir, name);
            if (isFile(full))
                return full;
        }
    }
    return undefined;
}
/**
 * Executável do Claude Code, em ordem: caminho configurado, binário embutido na extensão oficial
 * do VS Code, PATH e pastas conhecidas. Cai em "claude" se nada for achado.
 */
function resolveClaude(custom, claudeExtensionPath) {
    if (custom.trim())
        return custom.trim();
    if (claudeExtensionPath) {
        for (const name of ['claude.exe', 'claude']) {
            const candidate = path.join(claudeExtensionPath, 'resources', 'native-binary', name);
            if (isFile(candidate))
                return candidate;
        }
    }
    return findExecutable('claude') ?? 'claude';
}
// ---------- rodar .cmd/.bat no Windows ----------
// O Node não executa .cmd sem shell. Com shell, cada argumento precisa ser escapado para o cmd.exe,
// duas vezes porque o shim do npm repassa %* para outra linha de comando (mesma regra do cross-spawn).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function escapeCmdArg(arg) {
    let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
    a = `"${a}"`;
    return a.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
/** Como `execFile`, mas funciona também com `.cmd`/`.bat` no Windows. */
function runFile(file, args, options, callback) {
    const done = (err, stdout, stderr) => callback(err, String(stdout), String(stderr));
    if (isWin && /\.(cmd|bat)$/i.test(file)) {
        const line = [file.replace(CMD_META, '^$1'), ...args.map(escapeCmdArg)].join(' ');
        return (0, child_process_1.execFile)(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true }, done);
    }
    return (0, child_process_1.execFile)(file, args, options, done);
}
/** Encerra o processo e os filhos dele (no Windows, `kill` só derruba o cmd.exe intermediário). */
function killTree(child) {
    if (!child || child.exitCode !== null || child.pid === undefined)
        return;
    if (isWin) {
        (0, child_process_1.execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
    }
    else {
        child.kill();
    }
}
/** Versão do Node no PATH, ou undefined. O hook do Claude Code roda com `node`. */
function nodeVersion() {
    const node = findExecutable('node') ?? 'node';
    return new Promise((resolve) => {
        runFile(node, ['--version'], { timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : stdout.trim()));
    });
}
//# sourceMappingURL=platform.js.map