# KHANT AI — OpenAI Version

Flow:
Video -> OpenAI transcription -> Myanmar translation -> OpenAI TTS -> MP4
Text -> OpenAI TTS -> MP3

Requirements: Node.js 18+, FFmpeg, OpenAI API key.
Copy `.env.example` to `.env`, add the key, then:
npm install
npm start

Never expose OPENAI_API_KEY in public/app.js.
