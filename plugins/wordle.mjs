/* wordle —— 猜单词（内置词库，绿=位置对，黄=字母对） */
'use strict';
import { sessionOf, storage, str } from './_lib.mjs';

const WORDS = ['apple', 'beach', 'brain', 'chair', 'dance', 'eagle', 'flame', 'grape', 'house', 'jelly', 'knife', 'lemon', 'music', 'night', 'ocean', 'piano', 'queen', 'river', 'sunny', 'tiger', 'water', 'world', 'zebra', 'cloud', 'dream'];

function judge(guess, answer) {
  const res = Array(5).fill('b');
  const ans = answer.split('');
  for (let i = 0; i < 5; i++) if (guess[i] === ans[i]) { res[i] = 'g'; ans[i] = null; }
  for (let i = 0; i < 5; i++) {
    if (res[i] === 'b') {
      const k = ans.indexOf(guess[i]);
      if (k >= 0) { res[i] = 'y'; ans[k] = null; }
    }
  }
  return res;
}

export default {
  meta: { id: 'wordle', name: 'wordle', description: '猜单词：5 个字母，六次机会，绿=位置对、黄=字母对', category: '小游戏' },
  tools: [
    {
      name: 'qq_wordle_start',
      description: '开一局猜单词',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        storage('wordle').set('game:' + sess.key, { answer: WORDS[Math.floor(Math.random() * WORDS.length)], tries: 0 });
        return '🔤 Wordle 开局！猜一个 5 个字母的英文单词，共 6 次机会。\n🟩 位置和字母都对 🟨 字母对位置不对 ⬛ 没有';
      },
    },
    {
      name: 'qq_wordle_try',
      description: '猜一个 5 字母单词',
      inputSchema: {
        type: 'object',
        properties: {
          word: { type: 'string', description: '5 字母单词' },
          group_id: { type: 'number' }, user_id: { type: 'number' },
        },
        required: ['word'],
      },
      run: (args) => {
        const sess = sessionOf(args);
        const st = storage('wordle');
        const g = st.get('game:' + sess.key);
        if (!g) return '还没开局，先说"开始猜单词"。';
        const w = str(args.word).toLowerCase();
        if (!/^[a-z]{5}$/.test(w)) return '要一个 5 个字母的英文单词。';
        g.tries++;
        if (w === g.answer) { st.set('game:' + sess.key, undefined); return `🎉 猜对了！就是 **${g.answer.toUpperCase()}**，用了 ${g.tries} 次。`; }
        if (g.tries >= 6) { st.set('game:' + sess.key, undefined); return `六年用尽，答案是 **${g.answer.toUpperCase()}**。再来一局？`; }
        const marks = judge(w, g.answer).map((c) => ({ g: '🟩', y: '🟨', b: '⬛' }[c])).join('');
        st.set('game:' + sess.key, g);
        return `${w.toUpperCase()} ${marks}\n还剩 ${6 - g.tries} 次机会。`;
      },
    },
  ],
};
