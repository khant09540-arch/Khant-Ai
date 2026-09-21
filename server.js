require("dotenv").config();
const express=require("express"),multer=require("multer"),path=require("path"),fs=require("fs"),os=require("os");
const {execFile}=require("child_process"),{promisify}=require("util"),OpenAI=require("openai");
const exec=promisify(execFile),app=express(),PORT=process.env.PORT||3000;
const dir=path.join(os.tmpdir(),"khant-ai-openai");fs.mkdirSync(dir,{recursive:true});
const upload=multer({dest:dir,limits:{fileSize:500*1024*1024}});
const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
app.use(express.json({limit:"2mb"}));app.use(express.static(__dirname));
async function ff(args){await exec("ffmpeg",args,{maxBuffer:10*1024*1024});}
async function transcribe(file){
 const r=await openai.audio.transcriptions.create({file:fs.createReadStream(file),model:process.env.OPENAI_TRANSCRIBE_MODEL||"gpt-4o-transcribe"});
 return r.text||"";
}
async function translate(text){
 const r=await openai.responses.create({model:process.env.OPENAI_TEXT_MODEL||"gpt-5.6-luna",input:
 `Translate the following spoken script into natural conversational Myanmar (Burmese). Preserve names and meaning. Return only the Myanmar translation.\n\n${text}`});
 return r.output_text||"";
}
async function tts(text,out){
 const speech=await openai.audio.speech.create({
  model:process.env.OPENAI_TTS_MODEL||"gpt-4o-mini-tts",
  voice:process.env.OPENAI_TTS_VOICE||"coral",
  input:text,
  instructions:"Speak naturally and clearly in Myanmar (Burmese)."
 });
 fs.writeFileSync(out,Buffer.from(await speech.arrayBuffer()));
}
app.get("/api/health",(q,s)=>s.json({ok:true,openai:!!process.env.OPENAI_API_KEY}));
app.post("/api/voice",async(q,s)=>{
 let o;
 try{
  const text=String(q.body?.text||"").trim();if(!text)return s.status(400).json({error:"မြန်မာစာ ထည့်ပေးပါ။"});
  o=path.join(dir,Date.now()+"-voice.mp3");await tts(text,o);
  s.download(o,"khant-ai-myanmar-voice.mp3",()=>{try{fs.unlinkSync(o)}catch{}});
 }catch(e){s.status(500).json({error:e.message})}
});
app.post("/api/translate-video",upload.single("video"),async(q,s)=>{
 let i,a,v,o;
 try{
  if(!q.file)return s.status(400).json({error:"Video ရွေးပေးပါ။"});
  i=q.file.path;const id=Date.now();a=path.join(dir,id+"-audio.mp3");v=path.join(dir,id+"-voice.mp3");o=path.join(dir,id+"-mm.mp4");
  await ff(["-y","-i",i,"-vn","-ac","1","-ar","16000","-b:a","64k",a]);
  const original=await transcribe(a);if(!original.trim())throw Error("အသံမှ စာသားမထွက်ပါ။");
  const mm=await translate(original);await tts(mm,v);
  await ff(["-y","-i",i,"-i",v,"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest",o]);
  s.download(o,"khant-ai-myanmar.mp4",()=>[i,a,v,o].forEach(p=>{try{fs.unlinkSync(p)}catch{}}));
 }catch(e){[i,a,v,o].forEach(p=>{if(p)try{fs.unlinkSync(p)}catch{}});s.status(500).json({error:e.message})}
});
app.listen(PORT,()=>console.log("KHANT AI: http://localhost:"+PORT));
