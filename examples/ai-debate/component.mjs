// ai-debate component for dsh-bridge
// Multi-agent debate: pro and con sub-agents argue, then a judge decides.
// Inspired by DSH plugin shlouai/dsh-debate.
import https from 'node:https';

const API_HOST = 'api.deepseek.com';
const API_PATH = '/v1/chat/completions';
const MODEL = 'deepseek-chat';

function callDeepSeek(apiKey, messages, signal, temperature = 0.8, maxTokens = 800) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    });

    const req = https.request({
      hostname: API_HOST,
      path: API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
      signal,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 2_000_000) req.destroy(new Error('DeepSeek response is too large'));
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`API error: ${parsed.error.message}`));
            return;
          }
          const content = parsed.choices?.[0]?.message?.content || '';
          resolve(content.trim());
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}, body: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DeepSeek API timeout')); });
    req.write(body);
    req.end();
  });
}

export default {
  name: 'ai-debate',
  inject: ['bridgeCapabilities'],
  apply(ctx, config) {
    const apiKey = config.apiKey || '';
    if (!apiKey) {
      console.warn('[ai-debate] No apiKey configured in bridge.json');
    }

    ctx.bridgeCapabilities.register(ctx, 'ai_debate', async (args, invocation) => {
      const { topic } = args;
      const rounds = Math.min(Math.max(args.rounds || 2, 1), 3);

      if (!apiKey) throw new Error('No DeepSeek API key configured');

      invocation.progress(`Starting debate: "${topic}" (${rounds} rounds)`);

      const history = [];

      for (let r = 1; r <= rounds; r++) {
        invocation.progress(`Round ${r}/${rounds}: pro speaking...`);

        // Pro agent
        const proPrompt = [
          {
            role: 'system',
            content: `You are the PRO side of a formal debate. Your position: FOR the proposition.
Rules:
- State your strongest arguments concisely (300-500 Chinese characters).
- Use concrete examples, data, or reasoning.
- Do not mention you are an AI. Be persuasive and direct.
- This is round ${r}. Previous debate history:\n${history.map(h => `[${h.side}] ${h.text}`).join('\n') || '(none)'}`,
          },
          { role: 'user', content: `Debate proposition: ${topic}\n\nPresent your arguments for the PRO side.` },
        ];
        const proText = await callDeepSeek(apiKey, proPrompt, invocation.signal, 0.8, 600);
        history.push({ round: r, side: 'pro', text: proText });
        invocation.progress(`Round ${r}/${rounds}: con speaking...`);

        // Con agent (sees pro's latest argument)
        const conPrompt = [
          {
            role: 'system',
            content: `You are the CON side of a formal debate. Your position: AGAINST the proposition.
Rules:
- Refute the PRO arguments point by point.
- State your strongest counter-arguments concisely (300-500 Chinese characters).
- Use concrete examples, data, or reasoning.
- Do not mention you are an AI. Be persuasive and direct.
- This is round ${r}. Previous debate history:\n${history.map(h => `[${h.side}] ${h.text}`).join('\n') || '(none)'}`,
          },
          { role: 'user', content: `Debate proposition: ${topic}\n\nRefute the PRO arguments and present your case.` },
        ];
        const conText = await callDeepSeek(apiKey, conPrompt, invocation.signal, 0.8, 600);
        history.push({ round: r, side: 'con', text: conText });
      }

      // Judge
      invocation.progress('Judge is deliberating...');
      const judgePrompt = [
        {
          role: 'system',
          content: `You are a neutral, fair debate judge. You will review the full debate transcript and deliver a verdict.
Rules:
- Evaluate arguments on: logical coherence, evidence quality, persuasiveness, rebuttal quality.
- Declare a winner: "pro", "con", or "draw".
- Provide 2-3 sentences of reasoning in Chinese.
Be concise and specific.`,
        },
        {
          role: 'user',
          content: `Debate proposition: ${topic}\n\nFull transcript:\n${history.map(h => `=== Round ${h.round} [${h.side.toUpperCase()}] ===\n${h.text}`).join('\n\n')}\n\nDeliver your verdict. Start with "VERDICT: pro" / "VERDICT: con" / "VERDICT: draw", then your reasoning.`,
        },
      ];
      const verdictText = await callDeepSeek(apiKey, judgePrompt, invocation.signal, 0.3, 500);

      // Parse verdict
      const verdictMatch = verdictText.match(/VERDICT:\s*(pro|con|draw)/i);
      const winner = verdictMatch ? verdictMatch[1].toLowerCase() : 'draw';
      const reasoning = verdictText.replace(/VERDICT:\s*(pro|con|draw)\s*/i, '').trim();

      invocation.progress('Debate complete.');

      return {
        topic,
        rounds,
        winner,
        reasoning,
        transcript: history,
        judgeFullText: verdictText,
      };
    });
  },
};
