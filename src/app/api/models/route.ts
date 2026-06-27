/**
 * 功能：模型動態探測 API
 * 職責：並行呼叫 Google models.list + OpenRouter pricing API，篩選/排序/合併後回傳可用模型列表
 * 依賴：Google Generative AI REST API、OpenRouter REST API
 *
 * POST /api/models { apiKey } → { models: ModelChoice[] | null, error?: string }
 * apiKey 優先級：前端傳入 > 環境變數 GEMINI_API_KEY
 * Google 失敗 → 整體失敗（回 null）；OpenRouter 失敗 → 模型列表正常但無定價
 */

import { NextRequest, NextResponse } from 'next/server';

/** 前端消費的模型資訊 */
export interface ModelChoice {
  id: string;
  label: string;
  thinking: boolean;
  priceInput?: number;
  priceOutput?: number;
}

/** 排除非推理模型（embedding、TTS、圖片生成等） */
const SKIP_PATTERNS = /(embed|live-translate|tts|image-gen|-image|robotics|computer-use|native-audio|aqa)/i;

/**
 * 排序鍵：版本降序 → tier (pro > flash > lite) → 穩定版優先。
 * 移植自參考專案 model_registry.py `_model_sort_key`。
 */
function modelSortCompare(a: string, b: string): number {
  const parseKey = (name: string) => {
    const verMatch = name.match(/gemini-(\d+(?:\.\d+)?)/);
    const ver = verMatch ? parseFloat(verMatch[1]) : 0;
    const tier = name.includes('lite') ? 2 : name.includes('pro') ? 0 : 1;
    const suffix = (name.includes('preview') || name.includes('latest')) ? 1 : 0;
    return [-ver, tier, suffix] as const;
  };
  const ka = parseKey(a);
  const kb = parseKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return a.localeCompare(b);
}

/** POST /api/models — 探測可用模型 + 定價 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const body = await request.json();
    const key = body.apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
      return NextResponse.json(
        { models: null, error: '未提供 API Key' },
        { status: 400 },
      );
    }

    // 並行：Google models.list + OpenRouter pricing
    const [googleResult, pricingResult] = await Promise.allSettled([
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`,
        { signal: AbortSignal.timeout(15000) },
      ).then(r => {
        if (!r.ok) throw new Error(`Google API ${r.status}`);
        return r.json();
      }),
      fetch(
        'https://openrouter.ai/api/v1/models',
        { signal: AbortSignal.timeout(10000) },
      ).then(r => {
        if (!r.ok) throw new Error(`OpenRouter API ${r.status}`);
        return r.json();
      }),
    ]);

    // Google 失敗 → 整體失敗
    if (googleResult.status === 'rejected') {
      console.error(`[ModelsRoute][${timestamp}] ❌ Google models.list 失敗:`, googleResult.reason);
      return NextResponse.json(
        { models: null, error: `模型探測失敗: ${googleResult.reason}` },
        { status: 502 },
      );
    }

    // 篩選 Gemini 推理模型
    const apiModels: Array<Record<string, unknown>> = googleResult.value.models || [];
    const discovered: ModelChoice[] = [];
    for (const m of apiModels) {
      const name = String(m.name || '').replace('models/', '');
      if (!name.startsWith('gemini-')) continue;
      const methods = (m.supportedGenerationMethods || []) as string[];
      if (!methods.includes('generateContent')) continue;
      if (SKIP_PATTERNS.test(name)) continue;

      discovered.push({
        id: name,
        label: String(m.displayName || name),
        thinking: Boolean(m.thinking) || /pro/i.test(name),
      });
    }

    // OpenRouter 定價（容錯：失敗不影響模型列表）
    const pricing = new Map<string, { priceInput: number; priceOutput: number }>();
    if (pricingResult.status === 'fulfilled') {
      const data = pricingResult.value?.data;
      if (Array.isArray(data)) {
        for (const item of data) {
          const mid = String(item.id || '');
          if (!mid.startsWith('google/gemini-')) continue;
          const p = item.pricing;
          if (!p) continue;
          try {
            const pIn = parseFloat(p.prompt) * 1_000_000;
            const pOut = parseFloat(p.completion) * 1_000_000;
            if (pIn >= 0 && pOut >= 0) {
              pricing.set(mid.replace('google/', ''), {
                priceInput: Math.round(pIn * 100) / 100,
                priceOutput: Math.round(pOut * 100) / 100,
              });
            }
          } catch { /* 定價格式異常，跳過 */ }
        }
      }
    } else {
      console.warn(`[ModelsRoute][${timestamp}] ⚠️ OpenRouter 定價查詢失敗:`, pricingResult.reason);
    }

    // 合併定價 + 排序
    const models: ModelChoice[] = discovered
      .map(m => {
        const pr = pricing.get(m.id);
        return pr ? { ...m, priceInput: pr.priceInput, priceOutput: pr.priceOutput } : m;
      })
      .sort((a, b) => modelSortCompare(a.id, b.id));

    console.log(`[ModelsRoute][${timestamp}] ✅ 探測到 ${models.length} 個模型，${pricing.size} 個有定價`);
    return NextResponse.json({ models });
  } catch (err) {
    console.error(`[ModelsRoute][${timestamp}] ❌ 模型探測異常:`, err);
    return NextResponse.json(
      { models: null, error: '模型探測發生錯誤' },
      { status: 500 },
    );
  }
}
