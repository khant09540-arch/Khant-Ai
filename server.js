import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is not configured.");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const execFileAsync = promisify(execFile);

const uploadsDir = path.join(__dirname, "uploads");
const outputsDir = path.join(__dirname, "outputs");

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(outputsDir, { recursive: true });

app.use(express.json({ limit: "2mb" }));

// Frontend files are in repository root
app.use(express.static(__dirname));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const safeName = Date.now() + "-" +
      file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});


// -----------------------------
// Health check
// -----------------------------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    geminiConfigured: !!GEMINI_API_KEY
  });
});


// -----------------------------
// Gemini Video Translation
// -----------------------------

async function translateVideoToMyanmar(videoPath, mimeType) {

  console.log("Uploading video to Gemini...");

  let videoFile = await ai.files.upload({
    file: videoPath,
    config: {
      mimeType
    }
  });

  console.log("Gemini file:", videoFile.name);

  // Wait until Gemini finishes processing the video
  while (videoFile.state === "PROCESSING") {

    console.log("Video is still processing...");

    await new Promise(resolve =>
      setTimeout(resolve, 3000)
    );

    videoFile = await ai.files.get({
      name: videoFile.name
    });
  }

  if (videoFile.state === "FAILED") {
    throw new Error("Gemini video processing failed.");
  }

  console.log("Video ready.");

  const prompt = `
You are a professional Chinese/English to Myanmar video translator.

Watch and understand the entire uploaded video.

Your job:

1. Understand the spoken dialogue.
2. Translate the spoken content accurately into natural Myanmar language.
3. Keep the meaning, emotions and story.
4. Do NOT summarize.
5. Do NOT add explanations.
6. Do NOT include timestamps.
7. Do NOT include speaker labels.
8. Return ONLY the final Myanmar narration script.
9. Make the Myanmar script natural for AI voice narration.
10. Use short natural sentences suitable for speaking.

The final result must be in Myanmar Unicode.

Return only the Myanmar narration script.
`;

  console.log("Translating video...");

  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: [
      {
        fileData: {
          fileUri: videoFile.uri,
          mimeType: videoFile.mimeType
        }
      },
      prompt
    ]
  });

  const text = response.text?.trim();

  if (!text) {
    throw new Error("Gemini returned empty translation.");
  }

  console.log("Myanmar translation generated.");

  return text;
}


// -----------------------------
// Gemini Myanmar TTS
// -----------------------------

async function generateMyanmarVoice(text, outputPath) {

  console.log("Generating Myanmar AI voice...");

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",

    contents: [
      {
        parts: [
          {
            text:
              "Read this Myanmar narration naturally and clearly. " +
              "Use a warm Myanmar-speaking voice with natural pauses:\n\n" +
              text
          }
        ]
      }
    ],

    config: {
      responseModalities: ["AUDIO"],

      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: "Kore"
          }
        }
      }
    }
  });

  const part =
    response.candidates?.[0]?.content?.parts?.find(
      p => p.inlineData?.data
    );

  if (!part) {
    throw new Error("Gemini TTS did not return audio.");
  }

  const pcm = Buffer.from(
    part.inlineData.data,
    "base64"
  );

  // Gemini TTS returns raw PCM:
  // 24kHz / mono / 16-bit
  const wavHeader = Buffer.alloc(44);

  const sampleRate = 24000;
  const channels = 1;
  const bitsPerSample = 16;

  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + pcm.length, 4);
  wavHeader.write("WAVE", 8);

  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(channels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);

  const byteRate =
    sampleRate * channels * bitsPerSample / 8;

  wavHeader.writeUInt32LE(byteRate, 28);

  const blockAlign =
    channels * bitsPerSample / 8;

  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);

  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(pcm.length, 40);

  fs.writeFileSync(
    outputPath,
    Buffer.concat([wavHeader, pcm])
  );

  console.log("Myanmar voice saved.");

  return outputPath;
}


// -----------------------------
// Replace original video audio
// -----------------------------

async function createMyanmarVideo(
  inputVideo,
  voiceFile,
  outputVideo
) {

  console.log("Creating final Myanmar video...");

  await execFileAsync("ffmpeg", [
    "-y",

    "-i",
    inputVideo,

    "-i",
    voiceFile,

    "-map",
    "0:v:0",

    "-map",
    "1:a:0",

    "-c:v",
    "copy",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    outputVideo
  ]);

  console.log("Final video created.");

  return outputVideo;
}


// -----------------------------
// Main API
// -----------------------------

app.post(
  "/api/translate-video",
  upload.single("video"),
  async (req, res) => {

    let videoPath = null;
    let voicePath = null;
    let outputPath = null;

    try {

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "Video file မတွေ့ပါ။"
        });
      }

      if (!GEMINI_API_KEY) {
        return res.status(500).json({
          ok: false,
          error: "GEMINI_API_KEY မထည့်ရသေးပါ။"
        });
      }

      videoPath = req.file.path;

      const mimeType =
        req.file.mimetype || "video/mp4";

      const baseName =
        path.parse(req.file.filename).name;

      voicePath =
        path.join(
          outputsDir,
          `${baseName}-myanmar.wav`
        );

      outputPath =
        path.join(
          outputsDir,
          `${baseName}-myanmar.mp4`
        );


      // 1. Video → Myanmar script
      const myanmarText =
        await translateVideoToMyanmar(
          videoPath,
          mimeType
        );


      // 2. Myanmar script → Myanmar voice
      await generateMyanmarVoice(
        myanmarText,
        voicePath
      );


      // 3. Video + Myanmar voice → final MP4
      await createMyanmarVideo(
        videoPath,
        voicePath,
        outputPath
      );


      // Delete temporary files
      try {
        fs.unlinkSync(videoPath);
        fs.unlinkSync(voicePath);
      } catch {}


      const downloadUrl =
        `/outputs/${path.basename(outputPath)}`;

      res.json({
        ok: true,

        message:
          "မြန်မာဘာသာပြန် + မြန်မာ AI အသံ ထည့်ပြီးပါပြီ။",

        script:
          myanmarText,

        videoUrl:
          downloadUrl
      });

    } catch (error) {

      console.error(error);

      try {
        if (videoPath && fs.existsSync(videoPath))
          fs.unlinkSync(videoPath);

        if (voicePath && fs.existsSync(voicePath))
          fs.unlinkSync(voicePath);
      } catch {}

      res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Video processing failed."
      });
    }
  }
);


// Serve generated videos
app.use(
  "/outputs",
  express.static(outputsDir)
);


app.listen(PORT, () => {
  console.log(
    `Khant-Ai running on port ${PORT}`
  );
});
