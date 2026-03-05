const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const Redis = require('ioredis');

// --- 1. CONFIGURATION ---
const BOT_TOKEN = '8170920973:AAExkJs1jX7BqrAV2NW2hh6qU9oXpk7AN3o'; 
const CHANNEL_ID = '@NursingAchieversHub'; 
const REDIS_URL = 'redis://127.0.0.1:6379';

const bot = new Telegraf(BOT_TOKEN);
const redis = new Redis(REDIS_URL);
const timeouts = new Map(); // Stores the auto-skip timers

console.log("🚀 INITIALIZING NURSING ACHIEVERS BOT...");

// --- 2. DATA LOAD ---
let quizData = [];
try {
    quizData = JSON.parse(fs.readFileSync('questions.json', 'utf8'));
    console.log(`✅ SUCCESS: ${quizData.length} questions loaded.`);
} catch (err) {
    console.error("❌ ERROR: questions.json not found!");
    process.exit(1);
}

// --- 3. THE QUIZ ENGINE ---
async function sendQuestion(userId, chatId, index) {
    // End of Quiz Logic
    if (index >= quizData.length) {
        const session = await redis.hgetall(`session:${userId}`);
        const finalScore = session.score || 0;
        const name = session.userName || "Nursing Student";

        // Save to Leaderboard
        await redis.zadd('leaderboard', finalScore, name);

        await bot.telegram.sendMessage(chatId, 
            `🎊 *EXAM COMPLETE!*\n\n👤 Student: *${name}*\n✅ Final Score: *${finalScore}/${quizData.length}*\n\nType /leaderboard to see your rank!`, 
            { parse_mode: 'Markdown' }
        );
        
        await redis.del(`session:${userId}`);
        return;
    }

    const q = quizData[index];
    try {
        const poll = await bot.telegram.sendPoll(chatId, `[Q${index + 1}] ${q.question}`, q.options, {
            type: 'quiz',
            correct_option_id: q.correct_index,
            is_anonymous: false,
            open_period: 25,
            explanation: q.explanation || "Nursing Achievers Hub",
            protect_content: true 
        });

        // --- THE FAIL-SAFE TIMER ---
        // If no one answers, this skips to the next question automatically
        const timer = setTimeout(async () => {
            const currentSession = await redis.hgetall(`session:${userId}`);
            if (currentSession && parseInt(currentSession.index) === index) {
                console.log(`⏱ Auto-skipping Q${index + 1} for ${userId}`);
                const nextIndex = index + 1;
                await redis.hset(`session:${userId}`, 'index', nextIndex);
                bot.telegram.sendMessage(chatId, "⌛ *Time's up!* Moving to next...").catch(() => {});
                sendQuestion(userId, chatId, nextIndex);
            }
        }, 28000); // 28 seconds (poll closes at 25s)
        
        timeouts.set(userId, timer);

    } catch (e) {
        console.error("❌ POLL ERROR:", e.description);
    }
}

// --- 4. COMMANDS ---

// Start / Welcome
bot.start((ctx) => {
    ctx.reply(`🏥 *Welcome ${ctx.from.first_name}!*\n\nI am the Nursing Achievers Hub assistant. Ready to crack your exams?\n\nCommands:\n/runquiz - Start 100 Qs\n/leaderboard - View Top Scores\n/stop - Quit Quiz`, { parse_mode: 'Markdown' });
});

// Run Quiz
bot.command('runquiz', async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name;

    console.log(`📩 Request from ${name}`);

    // Subscription Check
    try {
        const member = await ctx.telegram.getChatMember(CHANNEL_ID, userId);
        const active = ['creator', 'administrator', 'member'].includes(member.status);
        if (!active) {
            return ctx.reply("⚠️ *JOIN REQUIRED*\nJoin the channel to start.", 
                Markup.inlineKeyboard([[Markup.button.url('📢 Join Channel', `https://t.me/${CHANNEL_ID.replace('@','')}`)]])
            );
        }
    } catch (e) {
        console.log("⚠️ Sub-check skipped.");
    }

    // Initialize Session
    await redis.del(`session:${userId}`);
    await redis.hmset(`session:${userId}`, { 
        index: 0, 
        score: 0, 
        chatId: ctx.chat.id, 
        userName: name 
    });

    sendQuestion(userId, ctx.chat.id, 0);
});

// Leaderboard
bot.command('leaderboard', async (ctx) => {
    const top = await redis.zrevrange('leaderboard', 0, 9, 'WITHSCORES');
    if (top.length === 0) return ctx.reply("🏆 Leaderboard is empty!");

    let list = "🏆 *TOP NURSING ACHIEVERS* 🏆\n\n";
    for (let i = 0; i < top.length; i += 2) {
        list += `${i/2 + 1}. *${top[i]}*: ${top[i+1]} pts\n`;
    }
    ctx.reply(list, { parse_mode: 'Markdown' });
});

// Stop Quiz
bot.command('stop', async (ctx) => {
    const userId = ctx.from.id;
    if (timeouts.has(userId)) {
        clearTimeout(timeouts.get(userId));
        timeouts.delete(userId);
    }
    await redis.del(`session:${userId}`);
    ctx.reply("🛑 Quiz stopped.");
});

// --- 5. ANSWER HANDLING ---
bot.on('poll_answer', async (ctx) => {
    const { user, option_ids } = ctx.pollAnswer;
    const userId = user.id;

    // Clear the auto-skip timer because they answered!
    if (timeouts.has(userId)) {
        clearTimeout(timeouts.get(userId));
        timeouts.delete(userId);
    }

    const session = await redis.hgetall(`session:${userId}`);
    if (!session.index) return;

    let index = parseInt(session.index);
    let score = parseInt(session.score);

    // Score update
    if (option_ids[0] === quizData[index].correct_index) {
        score++;
    }

    index++;
    await redis.hmset(`session:${userId}`, { index, score });

    // Small delay for smooth transition
    setTimeout(() => sendQuestion(userId, session.chatId, index), 1000);
});

// --- 6. LAUNCH ---
bot.launch().then(() => console.log("💎 SYSTEM ONLINE - LISTENING..."));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));