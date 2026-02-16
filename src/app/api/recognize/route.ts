/**
 * 功能：Gemini API 圖片識別端點（表格/圖表/文字）
 * 職責：接收裁切後的圖片 + Prompt，呼叫 Gemini API 回傳純文字（Markdown）
 * 依賴：@google/generative-ai、前端傳入的 apiKey（優先）或環境變數 GEMINI_API_KEY（fallback）
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';

/** 模型 429 配額耗盡時的自動退回映射 */
const MODEL_FALLBACK: Record<string, string> = {
  'gemini-3-pro-preview': 'gemini-3-flash-preview',
};

interface RecognizeResponse {
  success: boolean;
  text?: string;
  error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse<RecognizeResponse>> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const { image, prompt, model: modelId, page, regionId, apiKey: clientApiKey } = await request.json();

    if (!image || !prompt) {
      console.error(`[RecognizeRoute][${timestamp}] ❌ Missing image or prompt`);
      return NextResponse.json(
        { success: false, error: '缺少圖片或 Prompt' },
        { status: 400 }
      );
    }

    // 優先使用前端傳入的 apiKey，fallback 到環境變數
    const apiKey = clientApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      console.error(`[RecognizeRoute][${timestamp}] ❌ GEMINI_API_KEY not configured`);
      return NextResponse.json(
        { success: false, error: '請先設定 Gemini API 金鑰' },
        { status: 400 }
      );
    }

    const selectedModel = modelId || 'gemini-2.5-flash';
    const imageSizeKB = Math.round((image.length * 3) / 4 / 1024);
    console.log(`[RecognizeRoute][${timestamp}] 🔍 Recognizing page ${page} region ${regionId} with ${selectedModel} (image: ${imageSizeKB} KB)...`);

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

    let actualModel = selectedModel;
    let result;

    try {
      const modelObj = genAI.getGenerativeModel({ model: selectedModel });
      result = await modelObj.generateContent(contentParts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const fallback = MODEL_FALLBACK[selectedModel];
      if (fallback && errMsg.includes('429')) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[RecognizeRoute][${ts2}] ⚠️ ${selectedModel} quota exceeded, falling back to ${fallback}...`);
        actualModel = fallback;
        const fallbackObj = genAI.getGenerativeModel({ model: fallback });
        result = await fallbackObj.generateContent(contentParts);
      } else {
        throw err;
      }
    }

    if (actualModel !== selectedModel) {
      console.log(`[RecognizeRoute][${timestamp}] 🔄 Used fallback model: ${actualModel} (requested: ${selectedModel})`);
    }

    let text = result.response.text().trim();

    // 移除可能的 markdown code block 包裹
    const codeBlockMatch = text.match(/^```(?:markdown)?\s*([\s\S]*?)```$/);
    if (codeBlockMatch) {
      text = codeBlockMatch[1].trim();
    }

    console.log(`[RecognizeRoute][${timestamp}] ✅ Page ${page} region ${regionId}: ${text.length} chars recognized`);

    return NextResponse.json({ success: true, text });
  } catch (error) {
    console.error(`[RecognizeRoute][${timestamp}] ❌ Error:`, error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '未知錯誤',
      },
      { status: 500 }
    );
  }
}
