/**
 * 🎙️ Voicemail Auto-Summarizer
 * Twilio webhook → Transcription → Claude résumé → Email SendGrid
 */

const express = require("express");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");
const Anthropic = require("@anthropic-ai/sdk");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ─────────────────────────────────────────────
// ÉTAPE 1 : Twilio reçoit l'appel → décroche et enregistre
// ─────────────────────────────────────────────
app.post("/voicemail/incoming", (req, res) => {
  console.log("📞 Appel entrant de :", req.body.From);

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { language: "fr-CA", voice: "Polly.Chantal" },
    "Bonjour, vous êtes bien connecté à la boîte vocale. Veuillez laisser votre message après le bip."
  );

  twiml.record({
    action: "/voicemail/recorded",
    method: "POST",
    maxLength: 120,          // 2 minutes max
    timeout: 5,              // silence de 5s = fin du message
    transcribe: false,       // on utilise Claude à la place
    playBeep: true,
  });

  twiml.say({ language: "fr-CA" }, "Je n'ai pas reçu de message. Au revoir.");

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─────────────────────────────────────────────
// ÉTAPE 2 : Enregistrement terminé → analyse + email
// ─────────────────────────────────────────────
app.post("/voicemail/recorded", async (req, res) => {
  const { RecordingUrl, From, CallDuration, RecordingSid } = req.body;

  console.log(`🎙️ Message reçu de ${From} (${CallDuration}s) — ${RecordingUrl}`);

  // Répondre immédiatement à Twilio (évite timeout)
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ language: "fr-CA" }, "Votre message a bien été enregistré. Merci et bonne journée.");
  res.type("text/xml");
  res.send(twiml.toString());

  // Traitement asynchrone
  processVoicemail({ RecordingUrl, From, CallDuration, RecordingSid }).catch((err) => {
    console.error("❌ Erreur traitement:", err.message);
  });
});

// ─────────────────────────────────────────────
// TRAITEMENT PRINCIPAL
// ─────────────────────────────────────────────
async function processVoicemail({ RecordingUrl, From, CallDuration, RecordingSid }) {
  // 1. Télécharger l'audio (MP3) depuis Twilio
  console.log("⬇️  Téléchargement de l'audio...");
  const audioUrl = `${RecordingUrl}.mp3`;
  const authHeader = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  const audioResp = await fetch(audioUrl, {
    headers: { Authorization: `Basic ${authHeader}` },
  });

  if (!audioResp.ok) throw new Error(`Audio non récupérable: ${audioResp.status}`);

  const audioBuffer = await audioResp.buffer();
  const audioBase64 = audioBuffer.toString("base64");

  // 2. Envoyer à Claude pour transcription + résumé
  console.log("🤖 Analyse par Claude...");
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: `Tu es un assistant qui analyse des messages de boîte vocale.
Tu reçois un fichier audio et tu dois retourner UNIQUEMENT un objet JSON valide (sans backticks ni markdown) avec cette structure :
{
  "transcript": "transcription fidèle et complète du message",
  "caller_name": "nom de l'appelant s'il se présente, sinon null",
  "summary": "résumé clair en 2-3 phrases",
  "actions": ["action requise 1", "action requise 2"],
  "urgency": "haute | normale | faible",
  "callback_requested": true ou false,
  "callback_number": "numéro à rappeler si mentionné, sinon null"
}`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "audio/mpeg",
              data: audioBase64,
            },
          },
          {
            type: "text",
            text: "Analyse ce message vocal et retourne le JSON demandé.",
          },
        ],
      },
    ],
  });

  const rawText = response.content.map((b) => b.text || "").join("");
  const clean = rawText.replace(/```json|```/g, "").trim();
  const analysis = JSON.parse(clean);

  console.log("✅ Analyse terminée:", analysis.summary);

  // 3. Envoyer l'email de résumé
  await sendSummaryEmail({ analysis, From, CallDuration, RecordingSid, RecordingUrl });
}

// ─────────────────────────────────────────────
// ENVOI EMAIL
// ─────────────────────────────────────────────
async function sendSummaryEmail({ analysis, From, CallDuration, RecordingSid, RecordingUrl }) {
  const now = new Date().toLocaleString("fr-CA", { timeZone: "America/Toronto" });
  const urgencyEmoji = { haute: "🔴", normale: "🟡", faible: "🟢" }[analysis.urgency] || "🟡";
  const actionsHtml = analysis.actions?.length
    ? analysis.actions.map((a) => `<li style="margin:6px 0;">${a}</li>`).join("")
    : "<li>Aucune action requise</li>";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:580px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#7c6af7,#9b8fff);padding:28px 32px;">
      <div style="color:rgba(255,255,255,0.7);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:6px;">Boîte vocale</div>
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Nouveau message vocal</h1>
      <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:8px;">${now}</div>
    </div>

    <!-- Meta -->
    <div style="padding:24px 32px;border-bottom:1px solid #eee;display:flex;gap:24px;flex-wrap:wrap;">
      <div>
        <div style="font-size:11px;color:#999;letter-spacing:0.1em;text-transform:uppercase;">De</div>
        <div style="font-size:15px;font-weight:600;color:#222;margin-top:3px;">
          ${analysis.caller_name || From}
          ${analysis.caller_name ? `<span style="color:#999;font-weight:400;font-size:13px;"> — ${From}</span>` : ""}
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:#999;letter-spacing:0.1em;text-transform:uppercase;">Durée</div>
        <div style="font-size:15px;font-weight:600;color:#222;margin-top:3px;">${CallDuration}s</div>
      </div>
      <div>
        <div style="font-size:11px;color:#999;letter-spacing:0.1em;text-transform:uppercase;">Urgence</div>
        <div style="font-size:15px;font-weight:600;color:#222;margin-top:3px;">${urgencyEmoji} ${analysis.urgency}</div>
      </div>
    </div>

    <!-- Résumé -->
    <div style="padding:24px 32px;border-bottom:1px solid #eee;">
      <div style="font-size:11px;color:#999;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:10px;">Résumé</div>
      <p style="margin:0;font-size:15px;color:#333;line-height:1.7;">${analysis.summary}</p>
    </div>

    <!-- Actions -->
    <div style="padding:24px 32px;border-bottom:1px solid #eee;">
      <div style="font-size:11px;color:#999;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:10px;">Actions requises</div>
      <ul style="margin:0;padding-left:20px;color:#333;font-size:14px;line-height:1.7;">
        ${actionsHtml}
      </ul>
    </div>

    ${analysis.callback_requested ? `
    <!-- Rappel -->
    <div style="padding:20px 32px;background:#f0edff;border-bottom:1px solid #eee;">
      <span style="font-size:13px;color:#7c6af7;font-weight:600;">📲 Rappel demandé${analysis.callback_number ? ` au ${analysis.callback_number}` : ""}</span>
    </div>` : ""}

    <!-- Transcription -->
    <div style="padding:24px 32px;border-bottom:1px solid #eee;">
      <div style="font-size:11px;color:#999;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:10px;">Transcription complète</div>
      <p style="margin:0;font-size:13px;color:#666;line-height:1.8;font-style:italic;">"${analysis.transcript}"</p>
    </div>

    <!-- Footer -->
    <div style="padding:20px 32px;text-align:center;">
      <a href="${RecordingUrl}" style="display:inline-block;padding:10px 24px;background:#7c6af7;color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">
        🎧 Écouter le message
      </a>
      <div style="margin-top:16px;font-size:11px;color:#bbb;">Analysé par Claude · ID ${RecordingSid}</div>
    </div>
  </div>
</body>
</html>`;

  await sgMail.send({
    to: process.env.RECIPIENT_EMAIL,
    from: {
      email: process.env.SENDER_EMAIL,
      name: "Boîte Vocale",
    },
    subject: `🎙️ Message vocal${analysis.caller_name ? ` de ${analysis.caller_name}` : ` de ${From}`} — ${urgencyEmoji} ${analysis.urgency}`,
    html,
  });

  console.log(`📧 Email envoyé à ${process.env.RECIPIENT_EMAIL}`);
}

// ─────────────────────────────────────────────
// SANTÉ DU SERVEUR
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`   Webhook Twilio : POST /voicemail/incoming`);
});
