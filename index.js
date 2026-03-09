require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs');
const Redis = require('ioredis');
const express = require('express'); // 1. Added Express

// --- 0. WEB SERVER FOR RENDER ---
const app = express();
app.get('/', (req, res) => res.send('Nursing Achievers Hub Bot is Online! 🚀'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`✅ Health check server listening on port ${PORT}`);
});

// --- 1. CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// 2. Updated Redis to use environment variable
const redis = new Redis(process.env.REDIS_URL); 

const ADMIN_ID = 8587028561;
const NURSING_CHANNEL_ID = -1002317380108; 
const NURSING_HUB_ID = -1003592372674;     

let currentQuizIndex = -1;
let globalTimer = null;

// --- 2. DATA LOAD ---
let quizData = [];
try {
    const rawData = fs.readFileSync('questions.json', 'utf8');
    quizData = JSON.parse(rawData);
    console.log(`✅ DATABASE READY: ${quizData.length} questions loaded.`);
} catch (err) {
    console.error("❌ CRITICAL ERROR: Could not load questions.json!");
    process.exit(1);
}

// --- 3. THE DUAL-BROADCAST ENGINE ---
async function sendNextQuestion() {
    if (currentQuizIndex >= quizData.length) {
        const finishMsg = "🏁 *MARATHON FINISHED!*";
        await bot.telegram.sendMessage(NURSING_CHANNEL_ID, finishMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(NURSING_HUB_ID, finishMsg, { parse_mode: 'Markdown' });
        currentQuizIndex = -1;
        return;
    }

    const q = quizData[currentQuizIndex];

    try {
        const channelPoll = await bot.telegram.sendPoll(NURSING_CHANNEL_ID, `[Q${currentQuizIndex + 1}/${quizData.length}] ${q.question}`, q.options, {
            type: 'quiz',
            correct_option_id: q.correct_index,
            is_anonymous: true, 
            explanation: q.explanation || "Nursing Achievers Hub",
            open_period: 20,
            disable_notification: true,
            protect_content: true 
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        const groupPoll = await bot.telegram.sendPoll(NURSING_HUB_ID, `[Q${currentQuizIndex + 1}/${quizData.length}] ${q.question}`, q.options, {
            type: 'quiz',
            correct_option_id: q.correct_index,
            is_anonymous: false, 
            explanation: q.explanation || "Nursing Achievers Hub",
            open_period: 20,
            protect_content: true 
        });

        await redis.set(`poll:${groupPoll.poll.id}`, q.correct_index, 'EX', 3600);

        globalTimer = setTimeout(async () => {
            try {
                await bot.telegram.stopPoll(NURSING_CHANNEL_ID, channelPoll.message_id);
                await bot.telegram.stopPoll(NURSING_HUB_ID, groupPoll.message_id);
            } catch (e) { }

            setTimeout(() => {
                currentQuizIndex++;
                sendNextQuestion();
            }, 1000);

        }, 20000); 

    } catch (err) {
        console.error("Broadcast Error:", err.message);
        currentQuizIndex++;
        setTimeout(sendNextQuestion, 2000);
    }
}

// --- 4. ATOMIC SCORING ---
bot.on('poll_answer', async (ctx) => {
    try {
        const { user, poll_id, option_ids } = ctx.pollAnswer;
        const correctAnswer = await redis.get(`poll:${poll_id}`);

        if (correctAnswer !== null && option_ids[0] === parseInt(correctAnswer)) {
            await redis.zincrby('nursing_marathon_leaderboard', 1, user.id);
            const fullName = `${user.first_name} ${user.last_name || ''}`.trim();
            await redis.hset('user_names', user.id, fullName);
        }
    } catch (e) { console.error("Scoring Error:", e.message); }
});

// --- 5. COMMANDS ---
bot.command('startmarathon', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (currentQuizIndex !== -1) return ctx.reply("⚠️ Marathon running!");
    await redis.del('nursing_marathon_leaderboard');
    await ctx.reply("🚀 *Marathon Started!* (Content Protected 🔒)");
    currentQuizIndex = 0;
    sendNextQuestion();
});

bot.command('stopmarathon', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (globalTimer) {
        clearTimeout(globalTimer);
        currentQuizIndex = -1;
        ctx.reply("🛑 Stopped.");
    }
});

bot.command('leaderboard', async (ctx) => {
    const top = await redis.zrevrange('nursing_marathon_leaderboard', 0, 19, 'WITHSCORES');
    if (top.length === 0) return ctx.reply("🏆 No scores yet.");
    let board = "🏆 *TOP 20 ACHIEVERS* 🏆\n\n";
    for (let i = 0; i < top.length; i += 2) {
        const name = await redis.hget('user_names', top[i]) || "Candidate";
        board += `${(i/2)+1}. *${name}* — ${top[i+1]} pts\n`;
    }
    ctx.reply(board, { parse_mode: 'Markdown' });
});

// --- 6. LAUNCH ---
bot.launch().then(() => console.log("💎 SECURE PERFORMANCE SYSTEM ONLINE"));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM')); 