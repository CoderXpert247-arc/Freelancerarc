const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ===== Transporter =====
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,      // your Gmail
    pass: process.env.EMAIL_PASS       // App password
  }
});

// ===== Load and process HTML template =====
function loadTemplate(data) {
  const templatePath = path.join(__dirname, 'templates', 'emailTemplates.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  // Replace placeholders with actual data
  Object.keys(data).forEach(key => {
    const value = data[key] !== undefined ? data[key] : '';
    html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
  });

  return html;
}

// ===== Send email =====
async function sendEmail(to, subject, templateData = {}) {
  try {
    const html = loadTemplate(templateData);

    const info = await transporter.sendMail({
      from: `"Call Gateway" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html
    });

    console.log(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err.message);
    throw err;
  }
}

module.exports = sendEmail;