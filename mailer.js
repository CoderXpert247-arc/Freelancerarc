const fs = require('fs');
const path = require('path');
const sgMail = require('@sendgrid/mail');

// ===== SendGrid setup =====
if (!process.env.SENDGRID_API_KEY) {
  console.error("❌ SENDGRID_API_KEY is missing in .env");
} else {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// ===== Load and process HTML template =====
function loadTemplate(data = {}, templateFile = 'emailTemplates.html') {
  try {
    const templatePath = path.join(__dirname, 'templates', templateFile);

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

// ===== Send email function =====
async function sendEmail(to, subject, templateData = {}, templateFile = 'emailTemplates.html') {
  try {
    if (!to) throw new Error("Recipient email address is required");
    if (!process.env.EMAIL_FROM) throw new Error("EMAIL_FROM is not set in .env");

    // If OTP is passed as array, map to otp1..otp6 placeholders
    if (templateData.otp && Array.isArray(templateData.otp)) {
      for (let i = 0; i < 6; i++) {
        templateData[`otp${i + 1}`] = templateData.otp[i] || '';
      }
      delete templateData.otp; // remove original array to prevent conflicts
    }

    const html = loadTemplate(templateData, templateFile);

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

// ===== Test snippet =====
async function sendTestEmail() {
  try {
    if (!process.env.EMAIL_FROM) throw new Error("EMAIL_FROM is not set in .env");

    const otpArray = ['1', '2', '3', '4', '5', '6']; // test OTP

    const msg = {
      to: 'uchendugoodluck067@gmail.com', // recipient (replace with your Gmail for testing)
      from: process.env.EMAIL_FROM,       // verified sender in SendGrid
      subject: 'Test OTP Email from Call Gateway',
      html: loadTemplate({
        title: 'Test OTP',
        email: 'uchendugoodluck067@gmail.com',
        message: 'This is a test OTP email.',
        otp: otpArray
      }, 'otp-emailTemplates.html')
    };

    console.log("📧 Sending test email payload:", JSON.stringify(msg, null, 2));
    await sgMail.send(msg);
    console.log('✅ Test email sent successfully!');
  } catch (err) {
    console.error('❌ Error sending test email:', err.message);
    if (err.response && err.response.body && err.response.body.errors) {
      console.error("❌ SendGrid API errors:", err.response.body.errors);
    }
  }
}

// Uncomment to run test directly
// sendTestEmail();

module.exports = sendEmail;
module.exports.sendTestEmail = sendTestEmail;