const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const youtubedl = require('youtube-dl-exec');
const NodeID3 = require('node-id3');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const tasks = {};
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// Helper function to draw an animated progress bar in the terminal
function drawProgressBar(percentage, stepName) {
    const width = 30;
    const completed = Math.floor((percentage / 100) * width);
    const empty = width - completed;
    const bar = '█'.repeat(completed) + '░'.repeat(empty);
    process.stdout.write('\r⏳ ' + stepName + ' [' + bar + '] ' + percentage + '% ');
}

app.post('/convert', async (req, res) => {
    const { url, bitrate, metadata, image } = req.body;
    
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const taskId = uuidv4();
    tasks[taskId] = { status: 'downloading', progress: 0 };
    
    res.json({ task_id: taskId });

    console.log(`\n==================================================`);
    console.log(`🚀 NEW CONVERSION INITIATED`);
    console.log(`🆔 Task ID: ${taskId}`);
    console.log(`🔗 Target URL: ${url}`);
    console.log(`==================================================`);

    try {
        // --- PHASE 1: RETRIEVE DATA ---
        console.log(`\n[1/3] 📡 Retrieving YouTube music data...`);
        const videoInfo = await youtubedl(url, { dumpJson: true, noWarnings: true });
        const title = videoInfo.title.replace(/[^\w\s-]/g, ''); 
        
        console.log(`✅ Target Locked: "${title}"`);
        
        const finalAudioPath = path.join(tempDir, `${taskId}_final.mp3`);
        tasks[taskId].title = title;
        tasks[taskId].filename = `${title}.mp3`;
        tasks[taskId].progress = 10;

        // --- PHASE 2: DOWNLOAD & ENCODE WITH LIVE PROGRESS ---
        console.log(`\n[2/3] ⬇️ Downloading and 🎵 Encoding to ${bitrate || '320'}kbps MP3...`);
        
        const dlProcess = youtubedl.exec(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: `${bitrate || '320'}K`,
            output: finalAudioPath
        });

        dlProcess.stdout.on('data', (data) => {
            const text = data.toString();
            const match = text.match(/\[download\]\s+([\d\.]+)%/);
            if (match) {
                const pct = parseFloat(match[1]);
                tasks[taskId].progress = 10 + Math.floor(pct * 0.7); 
                drawProgressBar(pct.toFixed(1), 'Processing');
            }
        });

        await dlProcess;
        console.log(`\n✅ Audio successfully downloaded and encoded!`);
        tasks[taskId].progress = 80;

        if (!fs.existsSync(finalAudioPath)) {
            throw new Error('yt-dlp failed to generate the final MP3 file.');
        }

        // --- PHASE 3: APPLY METADATA ---
        console.log(`\n[3/3] 🏷️ Injecting ID3 tags and Album Art...`);
        let tags = {};
        if (metadata) {
            tags = {
                title: metadata.title || title,
                artist: metadata.artist || 'Unknown Artist',
                album: metadata.album || 'Unknown Album',
                year: metadata.year || '',
                genre: metadata.genre || ''
            };
        }

        if (image) {
            const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
            const imageBuffer = Buffer.from(base64Data, 'base64');
            tags.image = {
                mime: "image/jpeg",
                type: { id: 3, name: "front cover" },
                description: "Thumbnail",
                imageBuffer: imageBuffer
            };
            console.log(`🖼️ Custom Album Art attached.`);
        }

        NodeID3.write(tags, finalAudioPath);
        console.log(`✅ Metadata injected successfully!`);

        tasks[taskId].status = 'completed';
        tasks[taskId].progress = 100;

        const stats = fs.statSync(finalAudioPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        console.log(`\n🎉 TASK COMPLETE!`);
        console.log(`📄 MP3 File Details:`);
        console.table({
            "Filename": tasks[taskId].filename,
            "Size": `${fileSizeMB} MB`,
            "Bitrate": `${bitrate || '320'} kbps`,
            "Track Title": tags.title,
            "Artist": tags.artist,
            "Album": tags.album
        });
        console.log(`==================================================\n`);

    } catch (err) {
        console.log(`\n❌ ERROR ENCOUNTERED`);
        console.error(err.message);
        console.log(`==================================================\n`);
        
        tasks[taskId] = { 
            status: 'error', 
            error: err.message.includes('403') 
                ? 'HTTP 403 Forbidden: Google blocked it. Need cookies.txt' 
                : 'Failed to process URL.' 
        };
    }
});

app.get('/status/:taskId', (req, res) => {
    const task = tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
});

app.get('/download/:taskId', (req, res) => {
    const task = tasks[req.params.taskId];
    if (!task || task.status !== 'completed') {
        return res.status(400).send('File not ready or does not exist.');
    }

    const filePath = path.join(tempDir, `${req.params.taskId}_final.mp3`);
    res.download(filePath, task.filename, (err) => {
        if (!err) {
            setTimeout(() => fs.unlinkSync(filePath), 5000);
        }
    });
});

app.listen(PORT, () => {
    console.log(`NextGen Converter Engine running on http://127.0.0.1:${PORT}\nWaiting for tasks...`);
});