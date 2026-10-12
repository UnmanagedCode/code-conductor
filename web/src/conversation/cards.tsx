import { CheckIcon, ClipboardListIcon, MessageCircleQuestionIcon, PencilIcon, SendIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/components/Markdown';
import { cn } from '@/lib/utils';
import { buildApprovePrompt, buildRejectPrompt } from '../../../public/planApproval.ts';
import { formatUserQuestionAnswers } from '../../../public/userQuestionAnswers.ts';
import { send } from '@/lib/core/ws.js';
import { appStore } from '@/state/app';
import { ConversationModel, type PlanNode, type QuestionNode } from './model';

/**
 * Deliver a card answer as a normal user turn, acked so a send that never
 * reaches the CLI (reconnecting socket, killed instance, mid-rewind) re-opens
 * the card instead of leaving it "sending…" forever.
 */
function sendCardAnswer(instanceId: string, text: string, onFail: (reason: string) => void) {
  (send('prompt', { id: instanceId, text }, { ack: true }) as Promise<unknown>).catch((e: Error) => onFail(e?.message || 'send failed'));
}

export function PlanCard({ node, model }: { node: PlanNode; model: ConversationModel }) {
  const plan: string = typeof node.ev.plan === 'string' ? node.ev.plan : '';
  const locked = node.autoApproved || !!node.submitted;
  const status = node.autoApproved ? 'Auto-approved'
    : node.failedReason ? `Couldn't send: ${node.failedReason}`
    : node.submitted === 'approve' ? 'Approving…'
    : node.submitted === 'reject' ? 'Sending refinement…'
    : 'Awaiting your decision';

  async function decide(decision: 'approve' | 'reject') {
    const id = appStore.get().activeId;
    if (!id || locked) return;
    model.planSubmitted(node, decision);
    const fb = node.feedback.trim();
    const onFail = (reason: string) => model.planSendFailed(node.ev.toolUseId, reason);
    if (decision === 'approve') {
      // Leave plan mode first so the approved work isn't auto-denied tool by tool.
      try { await send('mode', { id, mode: 'bypassPermissions' }, { ack: true }); }
      catch (e) { console.warn('plan-approve mode switch failed', e); }
      sendCardAnswer(id, buildApprovePrompt(fb), onFail);
    } else {
      sendCardAnswer(id, buildRejectPrompt(fb), onFail);
    }
  }

  return (
    <div className={cn(
      'rounded-2xl border bg-card shadow-sm',
      node.autoApproved || node.submitted === 'approve' ? 'border-success/30' : node.submitted === 'reject' ? 'border-warning/30' : 'border-plan/35',
    )}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Badge variant="plan"><ClipboardListIcon /> Plan</Badge>
        <span className="text-sm font-medium">Ready for approval</span>
        <span className={cn('ml-auto text-xs', node.failedReason ? 'text-destructive' : 'text-muted-foreground')} data-status>{status}</span>
      </div>
      <div className="px-4 py-3">
        {node.ev.planPath && <div className="mb-2 font-mono text-xs text-muted-foreground">Saved to {node.ev.planPath}</div>}
        {plan.trim()
          ? <Markdown text={plan} className="whitespace-pre-wrap" />
          : <p className="text-sm text-muted-foreground italic">The plan wasn't sent inline. See the assistant output above.</p>}
      </div>
      {!node.autoApproved && (
        <div className="space-y-3 border-t px-4 py-3">
          <Textarea
            value={node.feedback}
            onChange={(e) => model.planFeedback(node, e.target.value)}
            disabled={locked}
            rows={2}
            placeholder="Feedback or refinements (sent with Reject; optional on Approve)"
            className="min-h-0 resize-y text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={locked} onClick={() => decide('approve')}><CheckIcon /> Approve &amp; implement</Button>
            <Button size="sm" variant="outline" disabled={locked} onClick={() => decide('reject')}><PencilIcon /> Reject &amp; refine</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({ node, model }: { node: QuestionNode; model: ConversationModel }) {
  const active = node.tab;
  const q = node.questions[active] ?? {};
  const answer = node.answers[active] ?? { kind: 'none' };
  const ready = ConversationModel.questionReady(node);
  const multi = node.questions.length > 1;
  const answeredCount = node.answers.filter((a) => a.kind !== 'none').length;
  const noteMode = answer.kind === 'option' || answer.kind === 'multi';
  const status = node.answered ? 'Answered'
    : node.failedReason ? `Couldn't send: ${node.failedReason}`
    : node.submitted ? 'Sending…'
    : multi ? `${answeredCount}/${node.questions.length} answered`
    : ready ? 'Ready to send' : 'Pick an option or write your own';

  function submit() {
    const id = appStore.get().activeId;
    if (!id || !ready || node.submitted) return;
    model.questionSubmitted(node);
    sendCardAnswer(id, formatUserQuestionAnswers(node.questions, node.answers), (reason) => model.questionSendFailed(node.toolUseId, reason));
  }

  const picked = (label: string) =>
    (answer.kind === 'option' && answer.label === label) || (answer.kind === 'multi' && answer.labels.includes(label));

  return (
    <div className={cn('rounded-2xl border bg-card shadow-sm', node.answered ? 'border-success/30' : 'border-info/35')}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Badge variant="info"><MessageCircleQuestionIcon /> Question</Badge>
        <span className="text-sm font-medium">The agent is asking you</span>
        <span className={cn('ml-auto text-xs', node.failedReason ? 'text-destructive' : 'text-muted-foreground')} data-status>{status}</span>
      </div>
      {multi && (
        <div role="group" aria-label="Questions" className="flex gap-1 overflow-x-auto border-b px-3 py-2">
          {node.questions.map((qq: any, i: number) => (
            <button
              key={i}
              type="button"
              aria-pressed={i === active}
              data-tab={i}
              onClick={() => model.questionTab(node, i)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
                i === active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              <span className={cn('flex size-4 items-center justify-center rounded-full text-[10px]', node.answers[i]?.kind !== 'none' ? 'bg-success text-white' : 'bg-background/30')}>
                {node.answers[i]?.kind !== 'none' ? '✓' : i + 1}
              </span>
              {qq.header || qq.question?.slice(0, 24) || `Q${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-3 px-4 py-3">
        <div>
          {q.header && <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{q.header}{q.multiSelect && ' · select any'}</div>}
          <div className="text-[15px] font-medium">{q.question ?? ''}</div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {(q.options ?? []).map((opt: any, oi: number) => {
            const label = opt.label ?? `Option ${oi + 1}`;
            const on = picked(opt.label ?? '');
            return (
              <button
                key={oi}
                type="button"
                disabled={node.submitted}
                data-option={opt.label ?? ''}
                aria-pressed={on}
                onClick={() => model.questionPick(node, active, opt.label ?? '')}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left text-sm transition-colors disabled:cursor-default',
                  on ? 'border-primary bg-primary/8 ring-1 ring-primary/30' : 'hover:border-foreground/20 hover:bg-muted/50',
                )}
              >
                <span className="font-medium">{label}</span>
                {opt.description && <span className="text-xs text-muted-foreground">{opt.description}</span>}
              </button>
            );
          })}
        </div>
        <Input
          value={node.drafts[active] ?? ''}
          onChange={(e) => model.questionDraft(node, active, e.target.value)}
          disabled={node.submitted}
          placeholder={noteMode ? 'Add a note (optional)' : 'Or write your own answer…'}
          data-custom-input={answer.kind === 'custom' ? 'active' : ''}
          className={cn(answer.kind === 'custom' && 'border-primary ring-1 ring-primary/30')}
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={!ready || node.submitted}>
            <SendIcon /> {multi ? 'Send all answers' : 'Send answer'}
          </Button>
        </div>
      </div>
    </div>
  );
}
