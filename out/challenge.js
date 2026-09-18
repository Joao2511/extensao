"use strict";
/**
 * Modo desafio: escolhe trechos de cada linha do gabarito para esconder no fantasma.
 * O aluno vê a estrutura da linha e o tamanho do que falta, mas precisa lembrar ou deduzir o conteúdo.
 * Sem dependência do VS Code, de propósito: dá para testar direto com node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.chooseHidden = chooseHidden;
exports.mask = mask;
/** Palavras que dão a estrutura da linha; ficam sempre visíveis. */
const KEYWORDS = new Set(('if else elif for while do return function def class new this self import export from as async await try catch except finally ' +
    'switch case break continue default const let var static public private protected void null undefined None true false True False ' +
    'in of not and or is with lambda yield throw raise super extends implements interface type enum package namespace using').split(' '));
/** Strings (com escapes), identificadores e números. */
const TOKEN_SOURCE = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|[A-Za-z_$][\\w$]*|\\d+(?:\\.\\d+)?`;
/** Trechos candidatos numa linha: identificadores (menos palavras-chave), números e o miolo de strings. */
function candidates(line, limit) {
    const out = [];
    const token = new RegExp(TOKEN_SOURCE, 'g');
    const text = line.slice(0, limit);
    let m;
    while ((m = token.exec(text))) {
        const found = m[0];
        const start = m.index;
        const quote = found[0];
        if (quote === '"' || quote === "'" || quote === '`') {
            if (found.length > 2)
                out.push([start + 1, start + found.length - 1]); // aspas ficam como dica
            continue;
        }
        if (found.length < 2 || KEYWORDS.has(found))
            continue;
        out.push([start, start + found.length]);
    }
    return out;
}
/**
 * Sorteia, em cada linha, uma fração `ratio` dos candidatos (pelo menos um, se houver).
 * `required` limita ao que precisa ser digitado: comentário preenchido sozinho não vira desafio.
 */
function chooseHidden(lines, required, ratio) {
    return lines.map((line, i) => {
        const pool = candidates(line, required?.[i] ?? line.length);
        if (!pool.length)
            return [];
        const count = Math.max(1, Math.round(pool.length * ratio));
        // Embaralha (Fisher-Yates) e fica com os primeiros.
        for (let j = pool.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [pool[j], pool[k]] = [pool[k], pool[j]];
        }
        return pool.slice(0, count).sort((a, b) => a[0] - b[0]);
    });
}
/** Linha com os trechos escondidos trocados por `fill`, um por caractere, para o alinhamento não mudar. */
function mask(line, ranges, fill = '_') {
    if (!ranges?.length)
        return line;
    let out = line;
    for (const [a, b] of ranges)
        out = out.slice(0, a) + fill.repeat(b - a) + out.slice(b);
    return out;
}
//# sourceMappingURL=challenge.js.map