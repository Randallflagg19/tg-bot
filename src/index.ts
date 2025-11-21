import { Telegraf, Context } from "telegraf";
import express, { Request, Response } from "express";
import dotenv from "dotenv";
import { resolve } from "path";
import { getAIResponse } from "./ai-service";
import { characterConfig } from "./character";

// Загружаем переменные окружения из корня проекта
dotenv.config({ path: resolve(process.cwd(), ".env") });

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const HF_API_KEY = process.env.HF_API_KEY;

const AI_ENABLED = !!HF_API_KEY;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN не найден в переменных окружения!");
}

const bot = new Telegraf(BOT_TOKEN);

// Простые ответы для команд (без AI)
const simpleResponses = {
  help: `Приветствую, ламповое сообщество! 👋

Я ${characterConfig.name}, и я здесь, чтобы общаться с вами!

Команды:
/start - начать общение
/help - показать это сообщение
/joke - получить шутку

Просто пиши мне что-нибудь, и я отвечу с характером! 😄`,

  joke: [
    "Почему криперы такие грустные? Потому что они не могут подойти и обнять! 💥",
    "Что говорит один блок другому? 'Ты выглядишь подозрительно!' 🧱",
    "Почему игроки боятся ночи? Потому что монстры не платят за свет! 🌙",
  ],
};

// Функция для случайного выбора ответа
function getRandomJoke(): string {
  const jokes = simpleResponses.joke;
  return jokes[Math.floor(Math.random() * jokes.length)];
}

// Обработчик команды /start
bot.command("start", async (ctx: Context) => {
  const firstName = ctx.from?.first_name || "ламповый человек";
  const userId = ctx.from?.id || 0;

  // Используем AI для приветствия
  const aiResponse = await getAIResponse(
    userId,
    `Привет! Я ${firstName}, и я только что начал общаться с тобой.`
  );

  if (aiResponse && aiResponse.success && aiResponse.message) {
    ctx.reply(aiResponse.message);
  } else {
    // Fallback на простое приветствие, если AI не доступен
    if (aiResponse?.errorType === "insufficient_balance") {
      ctx.reply(getInsufficientBalanceMessage(firstName));
    } else if (!aiResponse) {
      // Провайдер не настроен
      ctx.reply(getProviderSetupMessage(firstName));
    } else {
      // Ошибка API, но провайдер настроен
      ctx.reply(
        `Приветствую, ${firstName}! 👋\n\nУпс, что-то пошло не так с AI... Попробуй еще раз через секунду? 🔧`
      );
    }
  }
});

// Обработчик команды /help
bot.command("help", (ctx: Context) => {
  ctx.reply(simpleResponses.help);
});

// Обработчик команды /joke
bot.command("joke", (ctx: Context) => {
  ctx.reply(getRandomJoke());
});

// Обработчик всех текстовых сообщений
bot.on("text", async (ctx: Context) => {
  const message = ctx.message && "text" in ctx.message ? ctx.message.text : "";
  const userId = ctx.from?.id || 0;

  if (!message) return;

  // Пропускаем команды (они уже обработаны выше)
  if (message.startsWith("/")) {
    return;
  }

  try {
    // Показываем индикатор печати (опционально)
    await ctx.sendChatAction("typing");

    // Получаем ответ от AI
    const aiResponse = await getAIResponse(userId, message);

    if (!aiResponse) {
      // AI отключен (нет провайдера)
      await ctx.reply(getProviderSetupMessage());
    } else if (aiResponse.success && aiResponse.message) {
      // Успешный ответ от AI
      await ctx.reply(aiResponse.message);
    } else {
      // Ошибка API
      if (aiResponse.errorType === "insufficient_balance") {
        await ctx.reply(getInsufficientBalanceMessage());
      } else {
        await ctx.reply(
          `Приветствую, ламповое сообщество! 👋\n\nУпс, что-то пошло не так с AI... Попробуй еще раз через секунду? 🔧`
        );
      }
    }
  } catch (error) {
    console.error("Ошибка при обработке сообщения:", error);
    await ctx.reply(
      "Упс, что-то пошло не так... Но я уже работаю над этим! 🔧"
    );
  }
});

// Обработчик ошибок
bot.catch((err: unknown, ctx: Context) => {
  console.error("Ошибка в боте:", err);
  ctx.reply("Упс, что-то пошло не так... Но я уже работаю над этим! 🔧");
});

// Запуск бота
bot
  .launch()
  .then(() => {
    console.log("🤖 Бот запущен!");
    logProviderStatus();
  })
  .catch((err) => {
    console.error("Ошибка при запуске бота:", err);
  });

// Express сервер для Heroku
const app = express();

app.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    message: "KeinBot is running!",
    ai_enabled: AI_ENABLED,
    ai_provider: "Hugging Face",
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    ai_enabled: AI_ENABLED,
    ai_provider: "Hugging Face",
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
});

// Graceful shutdown
process.once("SIGINT", () => {
  bot.stop("SIGINT");
  process.exit(0);
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  process.exit(0);
});

function getProviderSetupMessage(firstName?: string): string {
  const prefix = firstName
    ? `Приветствую, ${firstName}! 👋`
    : "Приветствую, ламповое сообщество! 👋";

  return `${prefix}\n\nЯ ${characterConfig.name}, и я здесь, чтобы общаться с тобой!\n\n📝 Чтобы я мог отвечать умными ответами с характером, нужно настроить Hugging Face API ключ.\n\n🔑 Как это сделать:\n1. Создай токен на https://huggingface.co/settings/tokens\n2. Добавь его в файл .env:\n   HF_API_KEY=hf_...\n   HF_MODEL=meta-llama/Meta-Llama-3-8B-Instruct\n3. Перезапусти бота\n\n💡 Пока что я работаю без AI, но команды /help и /joke работают! 😄`;
}

function getInsufficientBalanceMessage(firstName?: string): string {
  const prefix = firstName
    ? `Приветствую, ${firstName}! 👋`
    : "Приветствую, ламповое сообщество! 👋";

  return `${prefix}\n\n*стук по столу* Всё!\n\nПохоже, Hugging Face вернул ошибку: недостаточно квоты или токен недействителен.\n\n💡 Проверь токен на https://huggingface.co/settings/tokens или попробуй другую бесплатную модель.\n\nПопробуй еще раз позже? 😊`;
}

function logProviderStatus(): void {
  if (!AI_ENABLED) {
    console.log("⚠️  AI-ответы отключены (HF_API_KEY не настроен)");
    return;
  }

  console.log("✅ AI-ответы включены (Hugging Face)");
}
