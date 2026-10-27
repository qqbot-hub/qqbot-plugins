/* idiom —— 成语接龙（本地成语库） */
'use strict';
import { sessionOf, storage, pick, str } from './_lib.mjs';

const IDIOMS = ['一帆风顺', '顺水推舟', '舟车劳顿', '顿开茅塞', '塞翁失马', '马到成功', '功成名就', '就地取材', '材雄德茂', '茂林修竹',
  '竹报平安', '安居乐业', '业精于勤', '勤能补拙', '拙口钝辞', '辞旧迎新', '新年快乐', '乐极生悲', '悲欢离合', '合情合理',
  '理直气壮', '壮志凌云', '云开见日', '日新月异', '异想天开', '开门见山', '山清水秀', '秀外慧中', '中流砥柱', '柱石之坚'];

export default {
  meta: { id: 'idiom', name: 'idiom', description: '成语接龙小游戏：开一局，群友按尾字接成语', category: '小游戏' },
  tools: [
    {
      name: 'qq_idiom_start',
      description: '开一局成语接龙，返回起始成语',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        const first = pick(IDIOMS);
        storage('idiom').set('game:' + sess.key, { last: first });
        return `📿 成语接龙开始！起始成语：「${first}」\n接一个以「${first.slice(-1)}」开头的成语。`;
      },
    },
    {
      name: 'qq_idiom_next',
      description: '接一个成语，检查首字是否等于上一个成语的尾字',
      inputSchema: {
        type: 'object',
        properties: {
          idiom: { type: 'string', description: '接的成语' },
          group_id: { type: 'number' }, user_id: { type: 'number' },
        },
        required: ['idiom'],
      },
      run: (args) => {
        const sess = sessionOf(args);
        const st = storage('idiom');
        const g = st.get('game:' + sess.key);
        if (!g) return '还没开局，先说"开始成语接龙"。';
        const w = str(args.idiom).replace(/，。/g, '');
        if (w.length < 4) return `「${w}」看着不像四字成语。`;
        if (w[0] !== g.last.slice(-1)) return `❌ 要接「${g.last.slice(-1)}」开头的成语，「${w}」不对。`;
        const next = IDIOMS.find((x) => x[0] === w.slice(-1) && x !== w) || pick(IDIOMS);
        g.last = next;
        st.set('game:' + sess.key, g);
        return `✅ 接得妙！我接：「${next}」\n该你接「${next.slice(-1)}」开头的了。`;
      },
    },
  ],
};
