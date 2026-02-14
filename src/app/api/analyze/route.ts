/**
 * 功能：Gemini API 分析端點
 * 職責：接收 PDF 頁面圖片 + Prompt，呼叫 Gemini API 回傳標註區域與券商名（report）
 * 依賴：@google/generative-ai、環境變數 GEMINI_API_KEY
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';
import { AnalyzeResponse } from '@/lib/types';

export async function POST(request: NextRequest): Promise<NextResponse<AnalyzeResponse>> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const { image, prompt, page, model: modelId } = await request.json();

    if (!image || !prompt) {
      console.error(`[AnalyzeRoute][${timestamp}] ❌ Missing image or prompt`);
      return NextResponse.json(
        { success: false, error: '缺少圖片或 Prompt' },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      console.error(`[AnalyzeRoute][${timestamp}] ❌ GEMINI_API_KEY not configured`);
      return NextResponse.json(
        { success: false, error: 'GEMINI_API_KEY 未設定' },
        { status: 500 }
      );
    }

    const selectedModel = modelId || 'gemini-2.0-flash';
    const imageSizeKB = Math.round((image.length * 3) / 4 / 1024);
    console.log(`[AnalyzeRoute][${timestamp}] 📄 Analyzing page ${page} with ${selectedModel} (image: ${imageSizeKB} KB)...`);

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: selectedModel });

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: image,
        },
      },
    ]);

    const responseText = result.response.text();

    // 嘗試解析 JSON — 可能被 markdown code block 包裹
    let jsonStr = responseText.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    console.log(
      `[AnalyzeRoute][${timestamp}] ✅ Page ${page}: hasAnalysis=${parsed.hasAnalysis}, regions=${parsed.regions?.length ?? 0}${parsed.report ? `, report=${parsed.report}` : ''}`
    );

    return NextResponse.json({
      success: true,
      data: {
        page,
        hasAnalysis: parsed.hasAnalysis ?? false,
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
