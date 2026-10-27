/* blackjack —— 21 点 */
'use strict';
import { sessionOf, storage, randInt } from './_lib.mjs';

const val = (h) => {
  let s = 0, aces = 0;
  for (const c of h) { if (c === 'A') { aces++; s += 11; } else if (['K', 'Q', 'J'].includes(c)) s += 10; else s += +c; }
  while (s > 21 && aces--) s -= 10;
  return s;
};
const draw = (h) => h.push(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][randInt(0, 12)]);
const show = (h, hideFirst) => (hideFirst ? '? ' : '') + h.join(' ');

export default {
  meta: { id: 'blackjack', name: 'blackjack', description: '21 点：要牌或停牌，跟庄家比大小', category: '小游戏' },
  tools: [
    {
      name: 'qq_bj_start',
      description: '开一局 21 点',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        const g = { player: [], dealer: [] };
        draw(g.player); draw(g.dealer); draw(g.player); draw(g.dealer);
        storage('blackjack').set('game:' + sess.key, g);
        return `🃏 开局！\n你的牌：${show(g.player)}（${val(g.player)} 点）\n庄家：${show(g.dealer, true)}\n发「要牌」或「停牌」。`;
      },
    },
    {
      name: 'qq_bj_hit',
      description: '再要一张牌',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        const st = storage('blackjack');
        const g = st.get('game:' + sess.key);
        if (!g || g.done) return '没有进行中的对局，先开一局。';
        draw(g.player);
        const v = val(g.player);
        if (v > 21) { g.done = true; st.set('game:' + sess.key, g); return `🃏 你的牌：${g.player.join(' ')}（${v} 点）\n爆了！庄家赢。`; }
        st.set('game:' + sess.key, g);
        return `🃏 你的牌：${g.player.join(' ')}（${v} 点）\n继续要牌还是停牌？`;
      },
    },
    {
      name: 'qq_bj_stand',
      description: '停牌，让庄家抽完比大小',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        const st = storage('blackjack');
        const g = st.get('game:' + sess.key);
        if (!g || g.done) return '没有进行中的对局，先开一局。';
        while (val(g.dealer) < 17) draw(g.dealer);
        g.done = true;
        st.set('game:' + sess.key, g);
        const p = val(g.player), d = val(g.dealer);
        const result = d > 21 || p > d ? '你赢了！🎉' : p === d ? '平局。' : '庄家赢了。';
        return `🃏 结算\n你：${g.player.join(' ')}（${p} 点）\n庄家：${g.dealer.join(' ')}（${d} 点）\n${result}`;
      },
    },
  ],
};
