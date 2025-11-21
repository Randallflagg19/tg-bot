import dotenv from "dotenv";
import { resolve } from "path";
import { getSystemPrompt } from "./character";

// Загружаем переменные окружения из корня проекта
dotenv.config({ path: resolve(process.cwd(), ".env") });

const HF_API_KEY = process.env.HF_API_KEY;
const HF_MODEL = process.env.HF_MODEL ?? "meta-llama/Meta-Llama-3-8B-Instruct";

if (!HF_API_KEY) {
  console.warn("⚠️  HF_API_KEY не найден. Проверьте переменные окружения.");
}

// Кэш для последних сообщений (простая реализация)
const conversationHistory: Map<
  number,
  Array<{ role: "user" | "assistant"; content: string }>
> = new Map();
const MAX_HISTORY = 10; // Максимальное количество сообщений в истории

// Тип для результата AI-ответа
export type AIResponseResult = {
  success: boolean;
  message?: string;
  error?: string;
  errorType?:
    | "insufficient_balance"
    | "api_error"
    | "unknown"
    | "provider_unavailable";
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function getAIResponse(
  userId: number,
  userMessage: string
): Promise<AIResponseResult | null> {
  if (!HF_API_KEY) {
    return null; // AI отключен, если нет ключа
  }

  try {
    // Получаем историю разговора для пользователя
    let history = conversationHistory.get(userId) || [];

    // Создаем сообщения для API
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: getSystemPrompt(),
      },
      ...history,
      { role: "user", content: userMessage },
    ];

    const response = await callHuggingFace(messages);

    if (response.success && response.message) {
      history.push({ role: "user", content: userMessage });
      history.push({ role: "assistant", content: response.message });

      if (history.length > MAX_HISTORY) {
        history = history.slice(-MAX_HISTORY);
      }

      conversationHistory.set(userId, history);
    }

    return response;
  } catch (error) {
    console.error("Непредвиденная ошибка при генерации ответа:", error);
    return {
      success: false,
      error: "Непредвиденная ошибка",
      errorType: "unknown",
    };
  }
}

// Очистка истории для пользователя (опционально)
export function clearUserHistory(userId: number): void {
  conversationHistory.delete(userId);
}

async function callHuggingFace(
  messages: ChatMessage[]
): Promise<AIResponseResult> {
  if (!HF_API_KEY) {
    return {
      success: false,
      error: "HF_API_KEY отсутствует",
      errorType: "provider_unavailable",
    };
  }

  const prompt = buildPrompt(messages);

  try {
    console.log("=".repeat(60));
    console.log("🔍 ОТЛАДКА Hugging Face API");
    console.log("=".repeat(60));
    console.log(`Модель: ${HF_MODEL}`);
    console.log(`API Key: ${HF_API_KEY.substring(0, 10)}...${HF_API_KEY.substring(HF_API_KEY.length - 4)}`);
    console.log(`Промпт (первые 100 символов): ${prompt.substring(0, 100)}...`);
    console.log("");
    
    // Список моделей для перебора (если основная не работает)
    const modelsToTry = [
      HF_MODEL, // Основная модель
      "meta-llama/Meta-Llama-3-8B-Instruct",
      "mistralai/Mistral-7B-Instruct-v0.2",
      "Qwen/Qwen2.5-7B-Instruct",
      "google/gemma-7b-it",
      "HuggingFaceH4/zephyr-7b-beta",
    ];

    // Пробуем разные endpoints и форматы
    const endpoints = [
      {
        name: "router-v1 (v1/chat/completions) - основной",
        url: "https://router.huggingface.co/v1/chat/completions",
        body: (model: string) => ({
          model: model,
          messages: messages.map(m => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
          max_tokens: 200,
          temperature: 0.8,
        }),
      },
      {
        name: "router-v2 (hf-inference)",
        url: "https://router.huggingface.co/hf-inference",
        body: (model: string) => ({
          model: model,
          inputs: prompt,
          parameters: {
            max_new_tokens: 200,
            temperature: 0.8,
            top_p: 0.9,
            repetition_penalty: 1.1,
            return_full_text: false,
          },
        }),
      },
      {
        name: "router-v3 (models path)",
        url: (model: string) => `https://router.huggingface.co/models/${model}`,
        body: (model: string) => ({
          inputs: prompt,
          parameters: {
            max_new_tokens: 200,
            temperature: 0.8,
            top_p: 0.9,
            repetition_penalty: 1.1,
            return_full_text: false,
          },
        }),
      },
    ];

    let lastError: any = null;
    let response: Response | null = null;
    let lastResponseText: string = "";
    let successfulModel = "";
    let found = false;

    // Пробуем каждую модель с каждым endpoint
    outerLoop: for (const model of modelsToTry) {
      console.log(`\n🔄 Пробуем модель: ${model}`);
      
      for (const endpoint of endpoints) {
        try {
          const url = typeof endpoint.url === "function" ? endpoint.url(model) : endpoint.url;
          const body = endpoint.body(model);
          
          console.log(`\n📡 Пробуем endpoint: ${endpoint.name}`);
          console.log(`   URL: ${url}`);
          console.log(`   Модель: ${model}`);
          console.log(`   Body keys: ${Object.keys(body).join(", ")}`);
          
          response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${HF_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

          const status = response.status;
          const statusText = response.statusText;
          
          // Клонируем response для чтения текста без потери возможности прочитать JSON позже
          const responseClone = response.clone();
          lastResponseText = await responseClone.text().catch(() => "");
          
          console.log(`   Статус: ${status} ${statusText}`);
          console.log(`   Ответ (первые 200 символов): ${lastResponseText.substring(0, 200)}`);

          if (response.ok) {
            console.log(`\n✅ УСПЕХ! Endpoint ${endpoint.name} с моделью ${model} работает!`);
            successfulModel = model;
            found = true;
            console.log("=".repeat(60));
            // response еще не прочитан, можно использовать дальше
            break outerLoop;
          }

          if (response.status === 503) {
            console.log(`   ⚠️  Модель прогревается (503)`);
            try {
              const data = JSON.parse(lastResponseText);
              console.log(`   Данные прогрева: ${JSON.stringify(data).substring(0, 200)}`);
            } catch (e) {
              // ignore
            }
            // Продолжаем пробовать другие endpoints
            continue;
          }

          if (response.status === 410) {
            console.log(`   ⚠️  Endpoint больше не поддерживается (410)`);
            continue;
          }

          if (response.status === 404) {
            console.log(`   ❌ Модель не найдена (404)`);
            lastError = new Error(
              `404 Not Found: ${lastResponseText.substring(0, 200)}`
            );
            // Пробуем следующий endpoint для этой модели
            continue;
          }
          
          if (response.status === 400) {
            try {
              const errorData = JSON.parse(lastResponseText);
              if (errorData?.error?.code === "model_not_supported") {
                console.log(`   ❌ Модель не поддерживается (400)`);
                console.log(`   Сообщение: ${errorData.error.message}`);
                // Пробуем следующую модель
                break; // break из цикла endpoint, continue в цикле model
              }
            } catch (e) {
              // ignore
            }
          }

          lastError = new Error(
            `Status ${status}: ${statusText} - ${lastResponseText.substring(0, 200)}`
          );
          console.log(`   ❌ Ошибка: ${lastError.message}`);
        } catch (error: any) {
          lastError = error;
          console.log(`   ❌ Исключение: ${error.message}`);
          // Пробуем следующий endpoint
          continue;
        }
      }
    }

    if (!response) {
      console.log("\n❌ ВСЕ ENDPOINTS ПРОВАЛИЛИСЬ");
      console.log("=".repeat(60));
      throw lastError || new Error("Не удалось подключиться к API");
    }

    // Обрабатываем ответ
    if (response.status === 503) {
      console.log("\n⚠️  Модель прогревается (503)");
      try {
        const data = await response.json();
        console.log("Данные прогрева:", JSON.stringify(data, null, 2));
      } catch (e) {
        console.log("Не удалось распарсить JSON ответ прогрева");
      }
      return {
        success: false,
        error: "Модель прогревается. Попробуйте чуть позже.",
        errorType: "provider_unavailable",
      };
    }

    if (!response.ok) {
      console.log(`\n❌ Ошибка ответа: ${response.status} ${response.statusText}`);
      let errorData: any = null;
      try {
        errorData = await response.json();
        console.log("Данные ошибки:", JSON.stringify(errorData, null, 2));
      } catch (e) {
        console.log("Текст ошибки:", lastResponseText);
      }
      
      const errorMessage =
        errorData?.error ||
        errorData?.message ||
        errorData?.error?.message ||
        lastResponseText ||
        `Ошибка Hugging Face API (${response.status} ${response.statusText})`;

      console.error("\n❌ ИТОГОВАЯ ОШИБКА:", errorMessage);
      console.log("=".repeat(60));

      if (response.status === 404) {
        console.error(
          "💡 Проверьте:"
        );
        console.error("   1. Модель доступна: https://huggingface.co/" + HF_MODEL);
        console.error("   2. Вы приняли условия использования модели");
        console.error("   3. Токен имеет права Inference");
      }

      return {
        success: false,
        error: errorMessage,
        errorType: "api_error",
      };
    }

    console.log("\n✅ Получен успешный ответ!");
    let data: any;
    try {
      data = await response.json();
      console.log("Структура ответа:", JSON.stringify(data, null, 2).substring(0, 500));
    } catch (e) {
      console.error("Ошибка парсинга JSON:", e);
      return {
        success: false,
        error: "Не удалось распарсить ответ API",
        errorType: "api_error",
      };
    }

    const generatedText = extractGeneratedText(data);
    console.log(`Извлеченный текст (первые 100 символов): ${generatedText?.substring(0, 100) || "НЕТ"}`);

    if (!generatedText) {
      console.error("\n❌ Hugging Face API вернул пустой ответ");
      console.error("Полные данные:", JSON.stringify(data, null, 2));
      console.log("=".repeat(60));
      return {
        success: false,
        error: "Пустой ответ от Hugging Face",
        errorType: "api_error",
      };
    }

    console.log("\n✅ УСПЕХ! Ответ получен и обработан");
    console.log("=".repeat(60));
    return {
      success: true,
      message: generatedText.trim(),
    };
  } catch (error: any) {
    console.error("Ошибка при обращении к Hugging Face API:", error);
    return {
      success: false,
      error: error.message || "Неизвестная ошибка Hugging Face",
      errorType: "api_error",
    };
  }
}

function buildPrompt(messages: ChatMessage[]): string {
  const roleLabels: Record<ChatMessage["role"], string> = {
    system: "System",
    user: "User",
    assistant: "Assistant",
  };

  const history = messages
    .map((message) => `${roleLabels[message.role]}: ${message.content}`)
    .join("\n");

  return `${history}\nAssistant:`;
}

function extractGeneratedText(data: unknown): string | null {
  if (!data) {
    return null;
  }

  // OpenAI-совместимый формат (chat.completion)
  if (typeof data === "object" && data !== null) {
    const obj = data as any;
    
    // Формат: { choices: [{ message: { content: "..." } }] }
    if (obj.choices && Array.isArray(obj.choices) && obj.choices.length > 0) {
      const choice = obj.choices[0];
      if (choice.message && choice.message.content) {
        return choice.message.content;
      }
      if (choice.text) {
        return choice.text;
      }
    }
    
    // Старый формат Hugging Face
    if (obj.generated_text) {
      return obj.generated_text;
    }
    if (obj.output_text) {
      return obj.output_text;
    }
    if (obj.text) {
      return obj.text;
    }
  }

  // Массив ответов
  if (Array.isArray(data)) {
    const first = data[0];
    if (!first) return null;

    if (typeof first === "string") {
      return first;
    }

    if (typeof first === "object" && first !== null) {
      const candidate =
        (first as any).generated_text ??
        (first as any).output_text ??
        (first as any).text ??
        (first as any).content;

      if (typeof candidate === "string") {
        return candidate;
      }
    }
  } else if (typeof data === "string") {
    return data;
  }

  return null;
}

async function safeJson(response: Response): Promise<any | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
