require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sgMail = require('@sendgrid/mail');

// ===== SendGrid setup =====
if (!process.env.SENDGRID_API_KEY) {
  console.error("❌ SENDGRID_API_KEY is missing in .env");
} else {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// ===== Helper: Safe value formatter =====
function formatValue(val, fallback = "0") {
  if (val === undefined || val === null || val === "") return fallback;

  if (Array.isArray(val)) {
    return val.length ? val.join(', ') : fallback;
  }

  // If number → keep two decimals
  if (typeof val === 'number') return val.toFixed(2);

  return val;
}

// ===== Load and process HTML template =====
function loadTemplate(data = {}, templateFile = 'emailTemplates.html') {
  try {
    const templatePath = path.join(__dirname, 'templates', templateFile);

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Email template not found at ${templatePath}`);
    }

    let html = fs.readFileSync(templatePath, 'utf8');

    // Pre-format telecom account fields
    data = {
      ...data,
      pin: formatValue(data.pin),
      balance: formatValue(data.balance),
      plans: formatValue(data.plans, "None"),
      planMinutes: formatValue(data.planMinutes),
      planExpires: formatValue(data.planExpires, "Not active"),
      referralBonus: formatValue(data.referralBonus),
      totalCalls: formatValue(data.totalCalls),
    };

    // OTP array → otp1…otp6
    if (data.otp && Array.isArray(data.otp)) {
      for (let i = 0; i < 6; i++) {
        data[`otp${i + 1}`] = data.otp[i] || '';
      }
      delete data.otp;
    }

    // Replace placeholders
    Object.keys(data).forEach(key => {
      const value = data[key] !== undefined ? data[key] : '';
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    });

    // Clean any unreplaced tags → default "0"
    html = html.replace(/{{.*?}}/g, "0");

    return html;
  } catch (err) {
    console.error("❌ Error loading email template:", err.message);
    throw err;
  }
}

// ===== Send email function =====
async function sendEmail(to, subject, templateData = {}, templateFile = 'emailTemplates.html') {
  try {
    if (!to) throw new Error("Recipient email address is required");
    if (!process.env.EMAIL_FROM) throw new Error("EMAIL_FROM is not set in .env");

    const html = loadTemplate(templateData, templateFile);

    const msg = {
      to,
      from: process.env.EMAIL_FROM,
      subject,
      html,
    };

    console.log("📧 Sending email:", subject, "→", to);

    const info = await sgMail.send(msg);
    console.log(`✅ Email successfully sent to ${to}`);
    return info;

  } catch (err) {
    if (err.response?.body?.errors) {
      console.error("❌ SendGrid API errors:", err.response.body.errors);
    } else {
      console.error(`❌ Failed to send email to ${to}:`, err.message);
    }
    throw err;
  }
}

// ===== Test OTP Email =====
async function sendTestEmail() {
  try {
    const otpArray = ['1','2','3','4','5','6'];

    const html = loadTemplate({
      title: 'Test OTP',
      email: 'uchendugoodluck067@gmail.com',
      message: 'This is a test OTP email.',
      otp: otpArray
    }, 'otp-emailTemplates.html');

    await sgMail.send({
      to: 'uchendugoodluck067@gmail.com',
      from: process.env.EMAIL_FROM,
      subject: 'Test OTP Email from Call Gateway',
      html
    });

    console.log('✅ Test OTP email sent successfully!');
  } catch (err) {
    console.error('❌ Test email failed:', err.message);
  }
}

// ===== Export functions =====
module.exports = sendEmail;
module.exports.sendTestEmail = sendTestEmail;