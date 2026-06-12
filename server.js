const express = require("express");
const twilio = require("twilio");
const { Resend } = require("resend");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const requiredEnvVars = ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "SENDER_EMAIL", "RECIPIENT_EMAIL"];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error("❌ Missing environment variables:", missing.join(", "));
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

app.post("/voicemail/incoming", (req, res) => {
  console.log("📞 Appel entrant de :", req.body.From);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ language: "fr-CA" }, "Bonjour, vous avez bien rejoint la boîte vocale d'Alexis Desrosiers, spécialiste hypothécaire pour la Banque TD. Merci de laisser votre message après le bip.");
  twiml.record({
    action: "/voicemail/recorded",
    method: "POST",
    maxLength: 120,
    timeout: 5,
    transcribe: true,
    transcribeCallback: "https://voicemail-summarizer.onrender.com/voicemail/transcribed",
    playBeep: true,
  });
  twiml.say({ language: "fr-CA" }, "Au revoir.");
  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/voicemail/recorded", (req, res) => {
  console.log(`🎙️ Message enregistré de ${req.body.From}`);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ language: "fr-CA" }, "Votre message a bien été enregistré. Merci et bonne journée.");
  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/voicemail/transcribed", async (req, res) => {
  const { TranscriptionText, From, RecordingUrl, RecordingSid } = req.body;
  console.log(`📝 Transcription reçue de ${From}: ${TranscriptionText}`);

  if (!TranscriptionText) {
    console.log("⚠️ Transcription vide — abandon");
    return res.sendStatus(200);
  }

  try {
    console.log("🤖 Analyse par Claude...");
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `Tu es un assistant qui analyse des messages de boîte vocale.
Retourne UNIQUEMENT un JSON valide (sans backticks) :
{
  "transcript": "transcription complète",
  "caller_name": "nom ou null",
  "summary": "résumé en 2-3 phrases",
  "actions": ["action 1"],
  "urgency": "haute | normale | faible",
  "callback_requested": true ou false,
  "callback_number": "numéro ou null"
}`,
      messages: [{
        role: "user",
        content: `Analyse ce message vocal transcrit automatiquement :\n\n"${TranscriptionText}"\n\nAppelant : ${From}`
      }]
    });

    const rawText = response.content.map((b) => b.text || "").join("");
    const clean = rawText.replace(/```json|```/g, "").trim();

    let analysis;
    try {
      analysis = JSON.parse(clean);
    } catch (parseErr) {
      console.error("❌ JSON parsing failed. Raw response:", rawText);
      return res.sendStatus(500);
    }

    console.log("✅ Analyse terminée:", analysis.summary);
    await sendSummaryEmail({ analysis, From, RecordingSid, RecordingUrl, transcript: TranscriptionText });
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erreur:", err.message, err.stack);
    res.sendStatus(500);
  }
});

async function sendSummaryEmail({ analysis, From, RecordingSid, RecordingUrl, transcript }) {
  const now = new Date().toLocaleString("fr-CA", { timeZone: "America/Toronto" });
  const urgencyEmoji = { haute: "🔴", normale: "🟡", faible: "🟢" }[analysis.urgency] || "🟡";
  const actionsHtml = analysis.actions?.length
    ? analysis.actions.map((a) => `<li style="margin:6px 0;">${a}</li>`).join("")
    : "<li>Aucune ac
