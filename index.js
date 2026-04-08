require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs');
const Redis = require('ioredis');
const express = require('express');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');

// --- WEB SERVER FOR RENDER ---
const app = express();
app.get('/', (req, res) => res.send('Nursing Achievers Hub Bot is Online! 🚀'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Health check server listening on port ${PORT}`));

// --- CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const redis = new Redis(process.env.REDIS_URL);
const ADMIN_ID = 8587028561;
const NURSING_CHANNEL_ID = -1002317380108;
const NURSING_HUB_ID = -1003592372674;

let currentQuizIndex = -1;
let globalTimer = null;

// --- DATA LOAD ---
let quizData = [];
try {
    quizData = JSON.parse(fs.readFileSync('questions.json', 'utf8'));
    console.log(`✅ DATABASE READY: ${quizData.length} questions loaded.`);
} catch (err) {
    console.error("❌ CRITICAL ERROR: Could not load questions.json!");
    process.exit(1);
}



// --- DUAL-BROADCAST ENGINE ---
async function sendNextQuestion() {
    if (currentQuizIndex >= quizData.length) {
        const top = await redis.zrevrange('nursing_marathon_leaderboard', 0, 19, 'WITHSCORES');

        let board = "🏁 *MARATHON FINISHED!* 🏁\n\n";
        if (top.length === 0) {
            board += "No scores were recorded today. 📊";
        } else {
            board += "🏆 *FINAL TOP 20 ACHIEVERS* 🏆\n\n";
            for (let i = 0; i < top.length; i += 2) {
                const rank = (i / 2) + 1;
                const name = await redis.hget('user_names', top[i]) || "Candidate";
                const medal = rank === 1 ? "🥇 " : rank === 2 ? "🥈 " : rank === 3 ? "🥉 " : `${rank}. `;
                board += `${medal}*${name}* — ${top[i+1]} pts\n`;
            }
        }

        await bot.telegram.sendMessage(NURSING_CHANNEL_ID, board, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(NURSING_HUB_ID, board, { parse_mode: 'Markdown' });
        currentQuizIndex = -1;
        return;
    }

    const q = quizData[currentQuizIndex];

    try {
        const explanation = (q.explanation || "Nursing Achievers Hub").substring(0, 200);

        const channelPoll = await bot.telegram.sendPoll(NURSING_CHANNEL_ID, `[Q${currentQuizIndex + 1}/${quizData.length}] ${q.question}`, q.options, {
            type: 'quiz', correct_option_id: q.correct_index, is_anonymous: true,
            explanation, open_period: 30, disable_notification: true, protect_content: true
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        const groupPoll = await bot.telegram.sendPoll(NURSING_HUB_ID, `[Q${currentQuizIndex + 1}/${quizData.length}] ${q.question}`, q.options, {
            type: 'quiz', correct_option_id: q.correct_index, is_anonymous: false,
            explanation, open_period: 30, protect_content: true
        });

        await redis.set(`poll:${groupPoll.poll.id}`, q.correct_index, 'EX', 3600);

        globalTimer = setTimeout(async () => {
            try {
                await bot.telegram.stopPoll(NURSING_CHANNEL_ID, channelPoll.message_id);
                await bot.telegram.stopPoll(NURSING_HUB_ID, groupPoll.message_id);
            } catch (e) { }
            setTimeout(() => { currentQuizIndex++; sendNextQuestion(); }, 1500);
        }, 30000);

    } catch (err) {
        console.error("Broadcast Error:", err.message);
        currentQuizIndex++;
        setTimeout(sendNextQuestion, 2000);
    }
}

// --- SCORING (GROUP ONLY) ---
bot.on('poll_answer', async (ctx) => {
    try {
        const { user, poll_id, option_ids } = ctx.pollAnswer;
        const correctAnswer = await redis.get(`poll:${poll_id}`);
        if (correctAnswer !== null && option_ids[0] === parseInt(correctAnswer)) {
            await redis.zincrby('nursing_marathon_leaderboard', 1, user.id);
            await redis.hset('user_names', user.id, `${user.first_name} ${user.last_name || ''}`.trim());
        }
    } catch (e) { console.error("Scoring Error:", e.message); }
});

// --- AUTOMATION (DISABLED FOR NOW) ---
// cron.schedule('0 21 * * *', async () => {
//     console.log("⏰ 9:00 PM: Marathon Triggered.");
//     if (currentQuizIndex !== -1) return console.log("⚠️ Skipped: already running.");
//     await redis.del('nursing_marathon_leaderboard');
//     try {
//         await bot.telegram.sendMessage(NURSING_HUB_ID, "🚀 *NURSING MARATHON STARTING NOW!* 🚀\n100 Questions on the way. Good luck, Achievers!", { parse_mode: 'Markdown' });
//         currentQuizIndex = 0;
//         sendNextQuestion();
//     } catch (err) { console.error("Auto-start failed:", err.message); }
// }, { scheduled: true, timezone: "Asia/Kolkata" });

// --- COMMANDS ---
bot.command('startmarathon', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (currentQuizIndex !== -1) return ctx.reply("⚠️ Marathon already running!");
    await redis.del('nursing_marathon_leaderboard');
    await ctx.reply("🚀 *Marathon Started Manually!*", { parse_mode: 'Markdown' });
    currentQuizIndex = 0;
    sendNextQuestion();
});

bot.command('stopmarathon', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (globalTimer) { clearTimeout(globalTimer); currentQuizIndex = -1; ctx.reply("🛑 Marathon Stopped."); }
});

bot.command('leaderboard', async (ctx) => {
    const top = await redis.zrevrange('nursing_marathon_leaderboard', 0, 19, 'WITHSCORES');
    if (top.length === 0) return ctx.reply("🏆 No scores yet.");
    let board = "🏆 *CURRENT TOP 20 ACHIEVERS* 🏆\n\n";
    for (let i = 0; i < top.length; i += 2) {
        const name = await redis.hget('user_names', top[i]) || "Candidate";
        board += `${(i/2)+1}. *${name}* — ${top[i+1]} pts\n`;
    }
    ctx.reply(board, { parse_mode: 'Markdown' });
});

// --- PDF UPLOAD (ADMIN ONLY) ---
bot.on('document', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const doc = ctx.message.document;
    if (doc.mime_type !== 'application/pdf') return ctx.reply("⚠️ Please send a PDF file only.");
    if (!process.env.GEMINI_API_KEY) return ctx.reply("❌ GEMINI_API_KEY not set in .env!");

    await ctx.reply("📄 PDF received! Converting with AI... ⏳ This may take 1-2 minutes.");

    try {
        const fileLink = await bot.telegram.getFileLink(doc.file_id);
        const pdfBuffer = await new Promise((resolve, reject) => {
            https.get(fileLink.href, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            }).on('error', reject);
        });

        const pdfBase64 = pdfBuffer.toString('base64');
        await ctx.reply(`✅ PDF downloaded (${(pdfBuffer.length / 1048576).toFixed(2)} MB). Sending to Gemini...`);

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        let result;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                result = await model.generateContent([GEMINI_PROMPT, { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }]);
                break;
            } catch (retryErr) {
                if (retryErr.message.includes('429') && attempt < 3) {
                    const wait = attempt * 60;
                    await ctx.reply(`⏳ Rate limited. Retrying in ${wait}s... (${attempt}/3)`);
                    await new Promise(r => setTimeout(r, wait * 1000));
                } else throw retryErr;
            }
        }

        const response = result.response.text();
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        let newQuestions = JSON.parse(jsonMatch ? jsonMatch[0] : response);

        newQuestions = newQuestions.filter(q =>
            q.question && Array.isArray(q.options) && q.options.length === 4 &&
            typeof q.correct_index === 'number' && q.correct_index >= 0 && q.correct_index <= 3 && q.explanation
        ).map(q => ({
            question: q.question.trim(),
            options: q.options.map(o => o.trim()),
            correct_index: q.correct_index,
            explanation: q.explanation.trim()
        }));

        if (newQuestions.length === 0) return ctx.reply("❌ No valid questions extracted from this PDF.");

        if (fs.existsSync('questions.json')) fs.copyFileSync('questions.json', `questions_backup_${Date.now()}.json`);
        fs.writeFileSync('questions.json', JSON.stringify(newQuestions, null, 2));
        quizData = newQuestions;

        await ctx.reply(
            `🎉 *SUCCESS!*\n\n✅ ${newQuestions.length} questions saved\n💾 Previous questions backed up\n🔄 Ready for next marathon!\n\n` +
            `*Sample:* ${newQuestions[0].question}\n*Answer:* ${newQuestions[0].options[newQuestions[0].correct_index]}`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error("PDF Convert Error:", err.message);
        ctx.reply(`❌ Error: ${err.message}`);
    }
});

// --- LAUNCH ---
bot.launch().then(() => console.log("💎 SYSTEM ONLINE & AUTOMATED FOR 9:00 PM IST"));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));