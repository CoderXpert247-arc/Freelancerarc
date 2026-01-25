const fs = require('fs');
const path = require('path');
const sgMail = require('@sendgrid/mail');

// ===== SendGrid setup =====
if (!process.env.SENDGRID_API_KEY) {
  console.error("❌ SENDGRID_API_KEY is missing in .env");
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Load and process HTML template =====
function loadTemplate(data = {}) {
  try {
    const templatePath = path.join(__dirname, 'templates', 'emailTemplates.html');

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Email template not found at ${templatePath}`);
    }

    let html = fs.readFileSync(templatePath, 'utf8');

    // Replace placeholders with actual data or empty string
    Object.keys(data).forEach(key => {
      const value = data[key] !== undefined ? data[key] : '';
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    });

    return html;
  } catch (err) {
    console.error("❌ Error loading email template:", err.message);
    throw err;
  }
}

// ===== Send email =====
async function sendEmail(to, subject, templateData = {}) {
  try {
    if (!to) throw new Error("Recipient email address is required");
    if (!process.env.EMAIL_FROM) throw new Error("EMAIL_FROM is not set in .env");

    const html = loadTemplate(templateData);

    const msg = {
      to,
      from: process.env.EMAIL_FROM, // must be verified on SendGrid
      subject,
      html,
    };

    console.log("📧 Sending email with payload:", JSON.stringify(msg, null, 2));

    const info = await sgMail.send(msg);

    console.log(`✅ Email successfully sent to ${to}`);
    return info;
  } catch (err) {
    // Detailed debug logging
    if (err.response && err.response.body && err.response.body.errors) {
      console.error("❌ SendGrid API errors:", err.response.body.errors);
    } else {
      console.error(`❌ Failed to send email to ${to}:`, err.message);
    }
    throw err;
  }
}

module.exports = sendEmail;