const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function loadTemplate(data) {
  let html = fs.readFileSync(path.join(__dirname, 'templates/emailTemplate.html'), 'utf8');

  Object.keys(data).forEach(key => {
    html = html.replace(new RegExp(`{{${key}}}`, 'g'), data[key]);
  });

  return html;
}

async function sendEmail(to, subject, templateData) {
  const html = loadTemplate(templateData);

  return transporter.sendMail({
    from: `"Call Gateway" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html
  });
}

module.exports = sendEmail;