/* weather —— 查天气（Open-Meteo 免费接口，无需 key） */
'use strict';
import { httpJson } from './_lib.mjs';

const CODES = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '小毛雨', 53: '毛雨', 55: '大毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨',
  81: '强阵雨', 82: '暴雨', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴',
};

export default {
  meta: { id: 'weather', name: 'weather', description: '查天气', category: '工具' },
  tools: [{
    name: 'qq_weather',
    description: '查某地天气（当前实况 + 今天）。群里有人问"明天冷不冷/要不要带伞"时用。',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string', description: '城市名，中文或拼音，如 北京 / Shanghai' } },
      required: ['location'],
    },
    run: async ({ location }) => {
      const city = String(location || '').trim();
      if (!city) return '告诉我地名呀，比如「北京」。';
      let geo;
      try {
        geo = await httpJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=' + encodeURIComponent(city));
      } catch { return '天气服务这会儿连不上，稍后再问吧。'; }
      const hit = geo && geo.results && geo.results[0];
      if (!hit) return `没找到叫「${city}」的地方，换个写法试试（如：北京 / Tokyo）。`;
      const w = await httpJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
        '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2'
      );
      const c = w.current, d = w.daily;
      const now = `${CODES[c.weather_code] || '未知'}，${Math.round(c.temperature_2m)}°C，湿度 ${c.relative_humidity_2m}%，风速 ${Math.round(c.wind_speed_10m)}km/h`;
      const today = `今天 ${CODES[d.weather_code[0]] || ''} ${Math.round(d.temperature_2m_min[0])}~${Math.round(d.temperature_2m_max[0])}°C，降水概率 ${d.precipitation_probability_max[0]}%`;
      const tomorrow = `明天 ${CODES[d.weather_code[1]] || ''} ${Math.round(d.temperature_2m_min[1])}~${Math.round(d.temperature_2m_max[1])}°C，降水概率 ${d.precipitation_probability_max[1]}%`;
      const tip = d.precipitation_probability_max[0] >= 50 ? '记得带伞 ☔' : '暂不用带伞';
      return `🌍 ${hit.name}${hit.admin1 ? '（' + hit.admin1 + '）' : ''}\n现在：${now}\n${today}\n${tomorrow}\n${tip}`;
    },
  }],
};
