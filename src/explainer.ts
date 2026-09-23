import { ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { killTree, runFile } from './platform';

/** Uma parte didática do trecho: linhas 1-based relativas ao trecho enviado. */
export interface Part {
  startLine: number;
  endLine: number;
  title: string;
  explanation: string;
}

export interface ExplainRequest {
  lines: string[];
  language: string;
  fileName: string;
  model: string;
  /** Nível de esforço do Claude (low…max); ausente deixa o padrão do modelo. */
  effort?: string;
}

const CACHE_DIR = path.join(os.homedir(), '.aprender', 'explicacoes');

/** Formato que o Claude é obrigado a devolver (--json-schema): nada de parsear texto solto. */
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          title: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['startLine', 'endLine', 'title', 'explanation'],
      },
    },
  },
  required: ['parts'],
});

const SYSTEM_PROMPT = [
  'Você é um professor de programação paciente. Seu aluno é iniciante e vai digitar este código à mão para aprender.',
  'Divida o código em partes didáticas, na ordem em que aparecem, cobrindo todas as linhas que têm conteúdo.',
  'Para cada parte dê um título curto e uma explicação em português simples, de 2 a 5 frases:',
  'o que ela faz, por que existe e o que aconteceria sem ela. Não repita o código na explicação.',
  'Use exatamente os números de linha mostrados.',
].join(' ');

/**
 * Pede a explicação ao Claude Code em modo não-interativo (`claude -p`), com o login da conta do usuário.
 * Não depende do VS Code, de propósito: dá para testar direto com node.
 */
export class Explainer {
  private child?: ChildProcess;

  constructor(private binary: string) {}

  async explain(req: ExplainRequest): Promise<Part[]> {
    const cacheFile = path.join(CACHE_DIR, this.cacheKey(req) + '.json');
    try {
      const cached = this.normalize(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).parts, req.lines.length);
      if (cached.length) return cached;
    } catch {
      /* sem cache: pergunta à IA */
    }

    const stdout = await this.run(req);
    let envelope: { is_error?: boolean; result?: unknown; structured_output?: { parts?: unknown } };
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new Error(`resposta inesperada do claude: ${stdout.slice(0, 200)}`);
    }
    if (envelope.is_error) throw new Error(String(envelope.result || 'erro desconhecido do claude'));
    const parts = this.normalize(envelope.structured_output?.parts, req.lines.length);
    if (!parts.length) throw new Error('a IA não devolveu partes');
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ parts }, null, 2));
    } catch {
      /* ficar sem cache não é erro */
    }
    return parts;
  }

  cancel() {
    killTree(this.child);
    this.child = undefined;
  }

  /** Mesmo trecho, mesma linguagem e mesmo modelo dão a mesma explicação: não gasta cota de novo. */
  private cacheKey(req: ExplainRequest) {
    return crypto
      .createHash('sha1')
      .update([req.model, req.effort ?? '', req.language, ...req.lines].join('\n'))
      .digest('hex');
  }

  private prompt(req: ExplainRequest) {
    const numbered = req.lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
    return `Arquivo: ${req.fileName} (${req.language}). Código com linhas numeradas:\n\n${numbered}`;
  }

  /** Roda o binário e devolve o stdout (um envelope JSON). O prompt vai por stdin: sem limite de tamanho de argumento. */
  private run(req: ExplainRequest): Promise<string> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', SCHEMA,
      '--system-prompt', SYSTEM_PROMPT,
      '--model', req.model,
      '--tools', '',
      '--no-session-persistence',
      '--strict-mcp-config',
    ];
    if (req.effort) args.push('--effort', req.effort);
    const env: NodeJS.ProcessEnv = { ...process.env, APRENDER_SKIP_HOOK: '1' };
    delete env.CLAUDECODE; // se o VS Code foi aberto de dentro do Claude Code, o filho recusaria rodar
    this.cancel();
    return new Promise((resolve, reject) => {
      const child = runFile(
        this.binary,
        args,
        { env, cwd: os.homedir(), maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
        (err, stdout, stderr) => {
          if (this.child === child) this.child = undefined;
          if (err && !stdout) return reject(new Error(stderr.trim() || err.message));
          resolve(stdout);
        },
      );
      this.child = child;
      child.stdin?.end(this.prompt(req));
    });
  }

  /** Linhas dentro do trecho, ordem crescente, sem partes vazias. */
  private normalize(raw: unknown, lineCount: number): Part[] {
    if (!Array.isArray(raw)) return [];
    const parts: Part[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      const start = Math.floor(Number(item?.startLine));
      const end = Math.floor(Number(item?.endLine));
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const first = Math.max(1, Math.min(lineCount, start));
      const last = Math.max(first, Math.min(lineCount, end));
      const explanation = String(item?.explanation ?? '').trim();
      if (!explanation) continue;
      const title = String(item?.title ?? '').trim() || `Linhas ${first}-${last}`;
      parts.push({ startLine: first, endLine: last, title, explanation });
    }
    return parts.sort((a, b) => a.startLine - b.startLine);
  }
}
