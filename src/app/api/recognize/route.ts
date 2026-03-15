/**
 * 功能：AI 圖片識別端點（表格/圖表/文字）（Gemini / OpenRouter 雙分支）
 * 職責：接收裁切後的圖片 + Prompt，依模型類型呼叫對應 API，回傳純文字（Markdown）
 * 依賴：@google/generative-ai（Gemini）、fetch（OpenRouter Chat Completions）
 *       前端傳入的 apiKey（Gemini）或 openRouterApiKey（OpenRouter），fallback 到環境變數
 * 推理：Gemini Flash 用 thinkingBudget: 0；Pro 系列用最小值 128；OpenRouter 無需 thinkingConfig
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';

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

/** 判斷是否為 OpenRouter 模型（model ID 含 "/" 即為 OpenRouter 格式） */
function isOpenRouterModel(modelId: string): boolean {
  return modelId.includes('/');
}

/** 呼叫 OpenRouter Chat Completions API，回傳模型生成的文字內容 */
async function callOpenRouter(modelId: string, apiKey: string, prompt: string, imageBase64: string): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ],
      }],
    }),
  });

  if (response.status === 429) {
    throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text)
      .join('');
  }
  throw new Error('OpenRouter: unexpected response format');
}

interface RecognizeResponse {
  success: boolean;
  text?: string;
  error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse<RecognizeResponse>> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const { image, prompt, model: modelId, page, regionId, apiKey: clientApiKey, openRouterApiKey: clientOrKey } = await request.json();

    if (!image || !prompt) {
      console.error(`[RecognizeRoute][${timestamp}] ❌ Missing image or prompt`);
      return NextResponse.json(
        { success: false, error: '缺少圖片或 Prompt' },
        { status: 400 }
      );
    }

    const selectedModel = modelId || 'gemini-2.5-flash';
    const imageSizeKB = Math.round((image.length * 3) / 4 / 1024);

    let text: string;

    if (isOpenRouterModel(selectedModel)) {
      // === OpenRouter 分支 ===
      const orApiKey = clientOrKey || process.env.OPENROUTER_API_KEY;
      if (!orApiKey) {
        console.error(`[RecognizeRoute][${timestamp}] ❌ OpenRouter API key not configured`);
        return NextResponse.json(
          { success: false, error: '請先設定 OpenRouter API 金鑰' },
          { status: 400 }
        );
      }

      console.log(`[RecognizeRoute][${timestamp}] 🔍 Recognizing page ${page} region ${regionId} with ${selectedModel} via OpenRouter (image: ${imageSizeKB} KB)...`);

      try {
        text = (await callOpenRouter(selectedModel, orApiKey, prompt, image)).trim();
      } catch (err) {
        const errObj = err as { status?: number; message?: string };
        if (errObj.status === 429 || (errObj.message ?? '').includes('429')) {
          const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(`[RecognizeRoute][${ts2}] ⚠️ ${selectedModel} rate limited (429)`);
          return NextResponse.json(
            { success: false, error: 'Rate limit exceeded', rateLimited: true },
            { status: 429 }
          );
        }
        throw err;
      }
    } else {
      // === Gemini 分支 ===
      const apiKey = clientApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
        console.error(`[RecognizeRoute][${timestamp}] ❌ GEMINI_API_KEY not configured`);
        return NextResponse.json(
          { success: false, error: '請先設定 Gemini API 金鑰' },
          { status: 400 }
        );
      }

      console.log(`[RecognizeRoute][${timestamp}] 🔍 Recognizing page ${page} region ${regionId} with ${selectedModel} (image: ${imageSizeKB} KB)...`);

      const genAI = new GoogleGenerativeAI(apiKey);
      const contentParts = [
        prompt,
        { inlineData: { mimeType: 'image/jpeg', data: image } },
      ];

      try {
        const modelObj = genAI.getGenerativeModel({
          model: selectedModel,
          generationConfig: getThinkingConfigMinimal(selectedModel),
        });
        const result = await modelObj.generateContent(contentParts);
        text = result.response.text().trim();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('429')) {
          const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(`[RecognizeRoute][${ts2}] ⚠️ ${selectedModel} rate limited (429)`);
          return NextResponse.json(
            { success: false, error: 'Rate limit exceeded', rateLimited: true },
            { status: 429 }
          );
        }
        throw err;
      }
    }

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
