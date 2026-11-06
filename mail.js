require("dotenv").config();
const nodemailer = require("nodemailer");
const { ALERT_TO = "raw.adarshn@gmail.com", GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;

const transport = GMAIL_USER && GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s/g, "") } })
  : null;

exports.send = async (subject, text) => {
  if (!transport) { console.error("[mail] NOT SENT (set GMAIL_USER and GMAIL_APP_PASSWORD):", subject); return false; }
  try { await transport.sendMail({ from: `Pingerr <${GMAIL_USER}>`, to: ALERT_TO, subject, text }); console.log("[mail] sent:", subject); return true; }
  catch (e) { console.error("[mail] FAILED:", e.message); return false; }
};
