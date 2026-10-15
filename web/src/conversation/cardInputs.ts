// Each card's unsent input, kept per session and tool_use id in memory, so a card rebuilt from a replaced
// transcript reads it back. The scope is read at every access; with no scope or no id every call is a no-op.
import type { QuestionNode } from './model';

type QuestionInput = Pick<QuestionNode, 'tab' | 'answers' | 'drafts'>;

export class CardInputs {
  private questions = new Map<string, QuestionInput>();
  private plans = new Map<string, string>();

  constructor(private scope: () => string | null) {}

  private key(toolUseId: string | null): string | null {
    const scope = this.scope();
    return scope === null || toolUseId === null ? null : `${scope}\n${toolUseId}`;
  }

  question(toolUseId: string | null): QuestionInput | undefined {
    const k = this.key(toolUseId);
    const saved = k === null ? undefined : this.questions.get(k);
    return saved && structuredClone(saved);
  }

  saveQuestion(node: QuestionNode) {
    const k = this.key(node.toolUseId);
    if (k !== null) this.questions.set(k, structuredClone({ tab: node.tab, answers: node.answers, drafts: node.drafts }));
  }

  dropQuestion(toolUseId: string | null) {
    const k = this.key(toolUseId);
    if (k !== null) this.questions.delete(k);
  }

  plan(toolUseId: string | null): string | undefined {
    const k = this.key(toolUseId);
    return k === null ? undefined : this.plans.get(k);
  }

  savePlan(toolUseId: string | null, text: string) {
    const k = this.key(toolUseId);
    if (k !== null) this.plans.set(k, text);
  }

  dropPlan(toolUseId: string | null) {
    const k = this.key(toolUseId);
    if (k !== null) this.plans.delete(k);
  }

  reset() {
    this.questions.clear();
    this.plans.clear();
  }
}
