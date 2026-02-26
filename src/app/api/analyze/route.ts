/**
 * 功能：Gemini API 分析端點
 * 職責：接收 PDF 頁面圖片 + Prompt，呼叫 Gemini API 回傳標註區域與券商名（report）
 * 依賴：@google/generative-ai、前端傳入的 apiKey（優先）或環境變數 GEMINI_API_KEY（fallback）
 * 推理：盡量設最低 — Flash 用 thinkingBudget: 0；Pro 系列強制 thinking mode，用最小值 128
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';
import { AnalyzeResponse } from '@/lib/types';

/** 強制 thinking mode 的模型（無法設 thinkingBudget: 0）— 2.5 Pro 最低 128，3 Pro / 3.1 Pro 僅支援 thinking */
const MODELS_REQUIRE_THINKING = new Set([
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-pro-preview',
]);

type GenConfig = Parameters<InstanceType<typeof GoogleGenerativeAI>['getGenerativeModel']>[0]['generationConfig'];

/** 依模型回傳最低推理程度：Pro 系列用 128，其餘用 0（關閉） */
function getThinkingConfigMinimal(modelId: string): NonNullable<GenConfig> {
  const budget = MODELS_REQUIRE_THINKING.has(modelId) ? 128 : 0;
  return { thinkingConfig: { thinkingBudget: budget } } as NonNullable<GenConfig>;
}

export async function POST(request: NextRequest): Promise<NextResponse<AnalyzeResponse>> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const { image, prompt, page, model: modelId, apiKey: clientApiKey } = await request.json();

    if (!image || !prompt) {
      console.error(`[AnalyzeRoute][${timestamp}] ❌ Missing image or prompt`);
      return NextResponse.json(
        { success: false, error: '缺少圖片或 Prompt' },
        { status: 400 }
      );
    }

    // 優先使用前端傳入的 apiKey，fallback 到環境變數
    const apiKey = clientApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      console.error(`[AnalyzeRoute][${timestamp}] ❌ GEMINI_API_KEY not configured`);
      return NextResponse.json(
        { success: false, error: '請先設定 Gemini API 金鑰' },
        { status: 400 }
      );
    }

    const selectedModel = modelId || 'gemini-2.5-flash';
    const imageSizeKB = Math.round((image.length * 3) / 4 / 1024);
    console.log(`[AnalyzeRoute][${timestamp}] 📄 Analyzing page ${page} with ${selectedModel} (image: ${imageSizeKB} KB)...`);

    const genAI = new GoogleGenerativeAI(apiKey);
    const contentParts = [
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: image,
        },
      },
    ];

    let result;

    try {
      const modelObj = genAI.getGenerativeModel({
        model: selectedModel,
        generationConfig: getThinkingConfigMinimal(selectedModel),
      });
      result = await modelObj.generateContent(contentParts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('429')) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[AnalyzeRoute][${ts2}] ⚠️ ${selectedModel} rate limited (429)`);
        return NextResponse.json(
          { success: false, error: 'Rate limit exceeded', rateLimited: true },
          { status: 429 }
        );
      }
      throw err;
    }

    const responseText = result.response.text();

    // 嘗試解析 JSON — 可能被 markdown code block 包裹
    let jsonStr = responseText.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    console.log(
      `[AnalyzeRoute][${timestamp}] ✅ Page ${page}: hasAnalysis=${parsed.hasAnalysis}, regions=${parsed.regions?.length ?? 0}${parsed.date ? `, date=${parsed.date}` : ''}${parsed.code ? `, code=${parsed.code}` : ''}${parsed.report ? `, report=${parsed.report}` : ''}`
    );

    return NextResponse.json({
      success: true,
      data: {
        page,
        hasAnalysis: parsed.hasAnalysis ?? false,
        date: parsed.date ?? undefined,
        code: parsed.code ?? undefined,
        report: parsed.report ?? undefined,
        regions: (parsed.regions ?? []).map((r: Record<string, unknown>, i: number) => {
          // Gemini 原生 bbox 格式為 [y1, x1, y2, x2]，轉換為前端使用的 [x1, y1, x2, y2]
          const raw = (r.bbox as number[]) ?? [0, 0, 0, 0];
          const bbox = [raw[1], raw[0], raw[3], raw[2]]; // [y1,x1,y2,x2] → [x1,y1,x2,y2]
          return {
            id: r.id ?? i + 1,
            bbox,
            label: r.label ?? `區域 ${i + 1}`,
            text: '', // 文字由前端根據 bbox 從 PDF 文字層提取
          };
        }),
      },
    });
  } catch (error) {
    console.error(`[AnalyzeRoute][${timestamp}] ❌ Error:`, error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '未知錯誤',
      },
      { status: 500 }
    );
  }
}
