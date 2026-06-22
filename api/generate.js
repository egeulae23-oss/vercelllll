const https = require('https');

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 30000;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      resolve(req.body);
      return;
    }

    if (typeof req.body === 'string') {
      try {
        resolve(JSON.parse(req.body));
      } catch (error) {
        reject(new Error('요청 JSON을 파싱할 수 없습니다'));
      }
      return;
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        req.destroy(new Error('요청 본문이 너무 큽니다'));
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('요청 JSON을 파싱할 수 없습니다'));
      }
    });
    req.on('error', reject);
  });
}

function stripJsonFence(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function requestAnthropic({ apiKey, model, systemPrompt, diary }) {
  const body = JSON.stringify({
    model,
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: `일기 내용:\n${diary}` }],
  });

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        let responseBody = '';

        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode || 500, body: responseBody });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Claude API 요청 시간이 초과되었습니다'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'POST만 허용됩니다' });
    return;
  }

  try {
    const body = await readRequestBody(req);
    const diary = typeof body.diary === 'string' ? body.diary.trim() : '';
    const pov = body.pov === 'third' ? 'third' : 'child';
    const tone = typeof body.tone === 'string' && body.tone.trim()
      ? body.tone.trim()
      : 'soft watercolor animation';
    const parentName = typeof body.parentName === 'string' && body.parentName.trim()
      ? body.parentName.trim()
      : '엄마';
    const childName = typeof body.childName === 'string' && body.childName.trim()
      ? body.childName.trim()
      : '아이';

    if (diary.length < 5) {
      sendJson(res, 400, { error: '일기 내용이 너무 짧습니다' });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      sendJson(res, 500, {
        error: 'ANTHROPIC_API_KEY 환경변수가 없습니다. Vercel 대시보드의 Settings > Environment Variables에서 추가해주세요.',
      });
      return;
    }

    const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    const povDescription = pov === 'child'
      ? `${childName}가 어른이 되어 회상하는 1인칭 시점`
      : '카메라가 바라보는 3인칭 내레이션 시점';

    const systemPrompt = `너는 부모의 육아일기를 분석해서 AI 영상 생성용 프롬프트를 만드는 전문가다.
반드시 아래 JSON 형식으로만 응답해라. 마크다운, 설명, 코드블록 없이 순수 JSON만 출력해라.
{
  "keywords": ["감정 키워드1", "키워드2", "키워드3", "키워드4"],
  "analysis": "상황 분석 2~3문장",
  "narration": "${povDescription}로 쓴 3~4문장 내레이션. 이모지 따옴표 없이 자연스러운 발화 텍스트로.",
  "prompt": "HeyGen Runway Kling 같은 영상 생성 도구에 바로 붙여넣을 수 있는 영문 프롬프트. 톤: ${tone}. ${parentName}를 주인공으로. 카메라 움직임 조명 분위기 포함. 60초 분량."
}`;

    const result = await requestAnthropic({
      apiKey,
      model,
      systemPrompt,
      diary,
    });

    if (result.status < 200 || result.status >= 300) {
      sendJson(res, 502, {
        error: `Claude API 오류 (${result.status})`,
        detail: result.body,
      });
      return;
    }

    let data;
    try {
      data = JSON.parse(result.body);
    } catch (error) {
      sendJson(res, 502, { error: 'Claude API 응답을 JSON으로 파싱할 수 없습니다', raw: result.body });
      return;
    }

    const rawText = (data.content || [])
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n');
    const cleaned = stripJsonFence(rawText);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (error) {
      sendJson(res, 502, { error: 'Claude 응답 파싱 실패', raw: cleaned });
      return;
    }

    sendJson(res, 200, {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 6) : [],
      analysis: typeof parsed.analysis === 'string' ? parsed.analysis : '',
      narration: typeof parsed.narration === 'string' ? parsed.narration : '',
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || '알 수 없는 서버 오류가 발생했습니다' });
  }
};
