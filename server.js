const express = require("express");
const twilio = require("twilio");
const { Resend } = require("resend");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

app.post("/voicemail/incoming", (req, res) => {
  console.log("📞 Appel entrant de :", req.body.From);
  const twiml = new twilio.twiml.VoiceResponse();
  
    action: "/voicemail/recorded",
    method: "POST",
    maxLength: 120,
    timeout: 5,
    transcribe: true,
    twiml.say({ language: "fr-CA" }, "Bonjour, vous avez bien rejoint la boîte vocale d'Alexis Desrosiers, spécialiste hypothécaire pour la Banque TD. Merci de laisser votre message après le bip.");
    transcribeCallback: "https://voicemail-summarizer.onrender.com/voicemail/transcribed",
    playBeep: true,
  });
  twiml.say({ language: "fr-CA", voice: "Polly.Gabrielle" }, "Je n'ai pas reçu de message. Au revoir.");
  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/voicemail/recorded", (req, res) => {
  console.log(`🎙️ Message enregistré de ${req.body.From} (${req.body.CallDuration}s)`);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ language: "fr-CA", voice: "Polly.Gabrielle" }, "Votre message a bien été enregistré. Merci et bonne journée.");
  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/voicemail/transcribed", async (req, res) => {
  res.sendStatus(200);
  const { TranscriptionText, From, RecordingUrl, RecordingSid } = req.body;
  console.log(`📝 Transcription reçue de ${From}: ${TranscriptionText}`);

  if (!TranscriptionText) {
    console.log("⚠️ Transcription vide — abandon");
    return;
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
    const analysis = JSON.parse(clean);
    console.log("✅ Analyse terminée:", analysis.summary);

    await sendSummaryEmail({ analysis, From, RecordingSid, RecordingUrl, transcript: TranscriptionText });
  } catch (err) {
    console.error("❌ Erreur:", err.message);
  }
});

async function sendSummaryEmail({ analysis, From, RecordingSid, RecordingUrl, transcript }) {
  const now = new Date().toLocaleString("fr-CA", { timeZone: "America/Toronto" });
  const urgencyEmoji = { haute: "🔴", normale: "🟡", faible: "🟢" }[analysis.urgency] || "🟡";
  const actionsHtml = analysis.actions?.length
    ? analysis.actions.map((a) => `<li style="margin:6px 0;">${a}</li>`).join("")
    : "<li>Aucune action requise</li>";

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:Arial,sans-serif;">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
<div style="background:linear-gradient(135deg,#7c6af7,#9b8fff);padding:28px 32px;">
<div style="color:rgba(255,255,255,0.7);font-size:11px;text-transform:uppercase;margin-bottom:6px;">Boîte vocale</div>
<h1 style="color:#fff;margin:0;font-size:22px;">Nouveau message vocal</h1>
<div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:8px;">${now}</div>
</div>
<div style="padding:24px 32px;border-bottom:1px solid #eee;">
<div style="font-size:11px;color:#999;text-transform:uppercase;">De</div>
<div style="font-size:15px;font-weight:600;color:#222;margin-top:3px;">${analysis.caller_name || From}</div>
<div style="font-size:11px;color:#999;text-transform:uppercase;margin-top:12px;">Urgence</div>
<div style="font-size:15px;font-weight:600;color:#222;margin-top:3px;">${urgencyEmoji} ${analysis.urgency}</div>
</div>
<div style="padding:24px 32px;border-bottom:1px solid #eee;">
<div style="font-size:11px;color:#999;text-transform:uppercase;margin-bottom:10px;">Résumé</div>
<p style="margin:0;font-size:15px;color:#333;line-height:1.7;">${analysis.summary}</p>
</div>
<div style="padding:24px 32px;border-bottom:1px solid #eee;">
<div style="font-size:11px;color:#999;text-transform:uppercase;margin-bottom:10px;">Actions requises</div>
<ul style="margin:0;padding-left:20px;color:#333;font-size:14px;">${actionsHtml}</ul>
</div>
${analysis.callback_requested ? `<div style="padding:20px 32px;background:#f0edff;border-bottom:1px solid #eee;"><span style="font-size:13px;color:#7c6af7;font-weight:600;">📲 Rappel demandé${analysis.callback_number ? ` au ${analysis.callback_number}` : ""}</span></div>` : ""}
<div style="padding:24px 32px;border-bottom:1px solid #eee;">
<div style="font-size:11px;color:#999;text-transform:uppercase;margin-bottom:10px;">Transcription</div>
<p style="margin:0;font-size:13px;color:#666;line-height:1.8;font-style:italic;">"${transcript}"</p>
</div>
<div style="padding:20px 32px;text-align:center;">
<a href="${RecordingUrl}" style="display:inline-block;padding:10px 24px;background:#7c6af7;color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">🎧 Écouter le message</a>
<div style="margin-top:16px;font-size:11px;color:#bbb;">Analysé par Claude · ID ${RecordingSid}</div>
</div>
</div></body></html>`;

  await resend.emails.send({
    from: `Boîte Vocale <${process.env.SENDER_EMAIL}>`,
    to: process.env.RECIPIENT_EMAIL,
    subject: `🎙️ Message vocal${analysis.caller_name ? ` de ${analysis.caller_name}` : ` de ${From}`} — ${urgencyEmoji} ${analysis.urgency}`,
    html,
  });

  console.log(`📧 Email envoyé à ${process.env.RECIPIENT_EMAIL}`);
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`   Webhook Twilio : POST /voicemail/incoming`);
});
