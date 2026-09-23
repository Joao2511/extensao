import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Instrução "explique antes de codar" para IAs sem hook de prompt (Codex, Gemini CLI, Antigravity).
 * Elas leem um arquivo global de instruções a cada conversa; a extensão escreve um bloco marcado nesse
 * arquivo enquanto está ligada e o remove quando desliga. O resto do arquivo nunca é tocado.
 */

const START = '<!-- aprender:inicio (bloco gerenciado pela extensão Aprender; some quando ela é desligada) -->';
const END = '<!-- aprender:fim -->';
const BLOCK_RE = /\n*<!-- aprender:inicio[^\n]*-->[\s\S]*?<!-- aprender:fim -->\n*/g;

export interface AgentTarget {
  name: string;
  /** Pasta da ferramenta; só escrevemos se ela existir (a pessoa usa a ferramenta nesta máquina). */
  dir: string;
  file: string;
}

export function agentTargets(): AgentTarget[] {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  const geminiHome = path.join(home, '.gemini');
  return [
    { name: 'Codex', dir: codexHome, file: path.join(codexHome, 'AGENTS.md') },
    { name: 'Gemini', dir: geminiHome, file: path.join(geminiHome, 'GEMINI.md') },
  ];
}

/** Conteúdo do arquivo com o bloco do Aprender inserido (text) ou removido (text vazio). */
export function withBlock(current: string, text: string): string {
  if (!text.trim() && !current.includes('<!-- aprender:inicio')) return current; // nada nosso para tirar
  const rest = current.replace(BLOCK_RE, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
  if (!text.trim()) return rest ? rest + '\n' : '';
  const block = `${START}\n${text.trim()}\n${END}\n`;
  return rest ? `${rest}\n\n${block}` : block;
}

/**
 * Aplica o bloco em todos os destinos. Devolve o que mudou, para o log.
 * `text` vazio remove o bloco.
 */
export function syncAgentRules(text: string, targets = agentTargets()): string[] {
  const changed: string[] = [];
  for (const t of targets) {
    try {
      if (!fs.statSync(t.dir).isDirectory()) continue;
    } catch {
      continue; // ferramenta não usada nesta máquina
    }
    let current = '';
    try {
      current = fs.readFileSync(t.file, 'utf8');
    } catch {
      if (!text.trim()) continue; // nada a remover de um arquivo que não existe
    }
    const next = withBlock(current, text);
    if (next === current) continue;
    try {
      fs.writeFileSync(t.file, next);
      changed.push(`${t.name}: ${t.file}`);
    } catch {
      /* sem permissão: segue sem a instrução */
    }
  }
  return changed;
}
