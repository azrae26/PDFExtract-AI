/**
 * 功能：Gemini API 圖片識別端點（表格/圖表/文字）
 * 職責：接收裁切後的圖片 + Prompt，呼叫 Gemini API 回傳純文字（Markdown）
 * 依賴：@google/generative-ai、環境變數 GEMINI_API_KEY
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';

interface RecognizeResponse {
  success: boolean;
  text?: string;
  error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse<RecognizeResponse>> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const { image, prompt, model: modelId, page, regionId } = await request.json();

    if (!image || !prompt) {
      console.error(`[RecognizeRoute][${timestamp}] ❌ Missing image or prompt`);
      return NextResponse.json(
        { success: false, error: '缺少圖片或 Prompt' },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      console.error(`[RecognizeRoute][${timestamp}] ❌ GEMINI_API_KEY not configured`);
      return NextResponse.json(
        { success: false, error: 'GEMINI_API_KEY 未設定' },
        { status: 500 }
      );
    }

    const selectedModel = modelId || 'gemini-2.0-flash';
    const imageSizeKB = Math.round((image.length * 3) / 4 / 1024);
    console.log(`[RecognizeRoute][${timestamp}] 🔍 Recognizing page ${page} region ${regionId} with ${selectedModel} (image: ${imageSizeKB} KB)...`);

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
