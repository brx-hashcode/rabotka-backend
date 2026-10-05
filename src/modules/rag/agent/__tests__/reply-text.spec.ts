import { replyText, toolNamesOf } from '../agent.service';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

describe('replyText', () => {
  it('keeps a plain string', () => {
    expect(replyText('Bonjour')).toBe('Bonjour');
  });

  it('turns an empty part list into nothing, never the text "[]"', () => {
    expect(replyText([])).toBe('');
  });

  it('joins the text parts and drops tool-use parts', () => {
    expect(
      replyText([
        { type: 'text', text: 'Le déblocage coûte ' },
        { type: 'tool_use', id: 't1', name: 'tarif_deblocage', input: {} },
        { type: 'text', text: '500 FCFA.' },
      ]),
    ).toBe('Le déblocage coûte 500 FCFA.');
  });

  it('treats a missing or odd content as empty', () => {
    expect(replyText(undefined)).toBe('');
    expect(replyText({ type: 'text' })).toBe('');
  });
});

describe('toolNamesOf', () => {
  it('lists the tools called, in order, across the run', () => {
    const messages = [
      new HumanMessage('combien ?'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: '1', name: 'tarif_deblocage', args: {} }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: '2', name: 'solde_credit', args: {} },
          { id: '3', name: 'rechercher_aide', args: { question: 'x' } },
        ],
      }),
      new AIMessage('500 FCFA'),
    ];
    expect(toolNamesOf(messages)).toEqual([
      'tarif_deblocage',
      'solde_credit',
      'rechercher_aide',
    ]);
  });
});
