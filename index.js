require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs');
const Redis = require('ioredis');
const express = require('express');
const cron = require('node-cron');

// --- 0. WEB SERVER FOR RENDER ---
const app = express();
app.get('/', (req, res) => res.send('Nursing Achievers Hub Bot is Online! 🚀'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`✅ Health check server listening on port ${PORT}`);
});

// --- 1. CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
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
    // --- AUTO-LEADERBOARD LOGIC AT END ---
    if (currentQuizIndex >= quizData.length) {
        // Helper to build leaderboard text
        async function buildLeaderboard(redisKey, title) {
            const top = await redis.zrevrange(redisKey, 0, 19, 'WITHSCORES');
            let board = `🏁 *MARATHON FINISHED!* 🏁\n\n`;
            if (top.length === 0) {
                board += "No scores were recorded. 📊";
            } else {
                board += `🏆 *${title}* 🏆\n\n`;
                for (let i = 0; i < top.length; i += 2) {
                    const userId = top[i];
                    const score = top[i+1];
                    const name = await redis.hget('user_names', userId) || "Candidate";
                    const rank = (i / 2) + 1;
                    
                    let rankDisplay = `${rank}. `;
                    if (rank === 1) rankDisplay = "🥇 ";
                    else if (rank === 2) rankDisplay = "🥈 ";
                    else if (rank === 3) rankDisplay = "🥉 ";

                    board += `${rankDisplay}*${name}* — ${score} pts\n`;
                }
            }
            return board;
        }

        const channelBoard = await buildLeaderboard('nursing_channel_leaderboard', 'FINAL TOP 20 — CHANNEL');
        const groupBoard = await buildLeaderboard('nursing_group_leaderboard', 'FINAL TOP 20 — GROUP');

        await bot.telegram.sendMessage(NURSING_CHANNEL_ID, channelBoard, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(NURSING_HUB_ID, groupBoard, { parse_mode: 'Markdown' });
        
        currentQuizIndex = -1;
        return;
    }

    const q = quizData[currentQuizIndex];

    try {
        // Send to Channel (Non-Anonymous for Scoring)
        const channelPoll = await bot.telegram.sendPoll(NURSING_CHANNEL_ID, `[Q${currentQuizIndex + 1}/${quizData.length}] ${q.question}`, q.options, {
            type: 'quiz',
            correct_option_id: q.correct_index,
            is_anonymous: false, 
            explanation: q.explanation || "Nursing Achievers Hub",
            open_period: 30,
            disable_notification: true,
            protect_content: true 
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // Send to Group (Non-Anonymous for Scoring)
        const groupPoll = await bot.telegram.sendPoll(NURSING_HUB_ID, `[Q${currentQuizIndex + 1}/${quizData.length}] ${q.question}`, q.options, {
            type: 'quiz',
            correct_option_id: q.correct_index,
            is_anonymous: false, 
            explanation: q.explanation || "Nursing Achievers Hub",
            open_period: 30,
            protect_content: true 
        });

        // Store correct answers in Redis for scoring (separate keys for channel & group)
        await redis.set(`poll:channel:${channelPoll.poll.id}`, q.correct_index, 'EX', 3600);
        await redis.set(`poll:group:${groupPoll.poll.id}`, q.correct_index, 'EX', 3600);

        globalTimer = setTimeout(async () => {
            try {
                await bot.telegram.stopPoll(NURSING_CHANNEL_ID, channelPoll.message_id);
                await bot.telegram.stopPoll(NURSING_HUB_ID, groupPoll.message_id);
            } catch (e) { }

            setTimeout(() => {
                currentQuizIndex++;
                sendNextQuestion();
            }, 1500); 

        }, 30000); 

    } catch (err) {
        console.error("Broadcast Error:", err.message);
        currentQuizIndex++;
        setTimeout(sendNextQuestion, 2000);
    }
}

// --- 4. ATOMIC SCORING (SEPARATE CHANNEL & GROUP) ---
bot.on('poll_answer', async (ctx) => {
    try {
        const { user, poll_id, option_ids } = ctx.pollAnswer;

        // Check if this poll belongs to channel or group
        const channelAnswer = await redis.get(`poll:channel:${poll_id}`);
        const groupAnswer = await redis.get(`poll:group:${poll_id}`);

        const fullName = `${user.first_name} ${user.last_name || ''}`.trim();
        await redis.hset('user_names', user.id, fullName);

        if (channelAnswer !== null && option_ids[0] === parseInt(channelAnswer)) {
            await redis.zincrby('nursing_channel_leaderboard', 1, user.id);
        }
        if (groupAnswer !== null && option_ids[0] === parseInt(groupAnswer)) {
            await redis.zincrby('nursing_group_leaderboard', 1, user.id);
        }
    } catch (e) { console.error("Scoring Error:", e.message); }
});

// --- 5. AUTOMATION (DAILY AT 9:00 PM IST) ---
cron.schedule('0 21 * * *', async () => {
    console.log("⏰ 9:00 PM: Marathon Automation Triggered.");
    if (currentQuizIndex !== -1) {
        console.log("⚠️ Marathon skipped: already running.");
        return; 
    }

    await redis.del('nursing_channel_leaderboard', 'nursing_group_leaderboard');
    const msg = "🚀 *NURSING MARATHON STARTING NOW!* 🚀\n100 Questions on the way. Good luck, Achievers!";
    
    try {
        await bot.telegram.sendMessage(NURSING_HUB_ID, msg, { parse_mode: 'Markdown' });
        currentQuizIndex = 0;
        sendNextQuestion();
    } catch (err) {
        console.error("Failed to start automated marathon:", err.message);
    }
}, {
    scheduled: true,
    timezone: "Asia/Kolkata" 
});

// --- 6. MANUAL COMMANDS ---
bot.command('startmarathon', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (currentQuizIndex !== -1) return ctx.reply("⚠️ Marathon already running!");
    await redis.del('nursing_channel_leaderboard', 'nursing_group_leaderboard');
    await ctx.reply("🚀 *Marathon Started Manually!*");
    currentQuizIndex = 0;
    sendNextQuestion();
});

bot.command('stopmarathon', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (globalTimer) {
        clearTimeout(globalTimer);
        currentQuizIndex = -1;
        ctx.reply("🛑 Marathon Stopped.");
    }
});

bot.command('leaderboard', async (ctx) => {
    const chatId = ctx.chat.id;
    // Show channel leaderboard in channel, group leaderboard in group
    const key = (chatId === NURSING_CHANNEL_ID) ? 'nursing_channel_leaderboard' : 'nursing_group_leaderboard';
    const label = (chatId === NURSING_CHANNEL_ID) ? 'CHANNEL' : 'GROUP';

    const top = await redis.zrevrange(key, 0, 19, 'WITHSCORES');
    if (top.length === 0) return ctx.reply("🏆 No scores yet.");
    let board = `🏆 *CURRENT TOP 20 — ${label}* 🏆\n\n`;
    for (let i = 0; i < top.length; i += 2) {
        const name = await redis.hget('user_names', top[i]) || "Candidate";
        board += `${(i/2)+1}. *${name}* — ${top[i+1]} pts\n`;
    }
    ctx.reply(board, { parse_mode: 'Markdown' });
});

// --- 7. LAUNCH ---
bot.launch().then(() => console.log("💎 SYSTEM ONLINE & AUTOMATED FOR 9:00 PM IST"));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));