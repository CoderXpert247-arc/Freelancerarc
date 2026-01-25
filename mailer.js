const fs = require('fs');
const path = require('path');
const sgMail = require('@sendgrid/mail');

// ===== SendGrid setup =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Load and process HTML template =====
function loadTemplate(data = {}) {
  try {
    const templatePath = path.join(__dirname, 'templates', 'emailTemplates.html');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Email template not found at ${templatePath}`);
    }

    let html = fs.readFileSync(templatePath, 'utf8');

    // Replace placeholders with actual data or empty string if undefined
    Object.keys(data).forEach(key => {
      const value = data[key] !== undefined ? data[key] : '';
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    });

    return html;
  } catch (err) {
    console.error("Error loading email template:", err.message);
    throw err;
  }
}

// ===== Send email =====
async function sendEmail(to, subject, templateData = {}) {
  try {
    if (!to) throw new Error("Recipient email address is required");

    const html = loadTemplate(templateData);

    const msg = {
      to,
      from: process.env.EMAIL_FROM, // verified SendGrid sender
      subject,
      html,
    };

    const info = await sgMail.send(msg);
    console.log(`Email sent to ${to}`);
    return info;
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err.message);
    throw err;
  }
}

module.exports = sendEmail;