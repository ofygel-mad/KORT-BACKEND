/**
 * Email sending via Gmail SMTP (nodemailer).
 *
 * Setup:
 *  1. Google Account -> Security -> 2-Step Verification -> App passwords
 *  2. Create an app password (16 chars, no spaces)
 *  3. Add to .env / Railway variables:
 *       EMAIL_USER=you@gmail.com
 *       EMAIL_PASS=abcdefghijklmnop
 *       APP_URL=https://kort.up.railway.app
 */

import nodemailer from 'nodemailer';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';
const EMAIL_USER = process.env.EMAIL_USER ?? '';
const EMAIL_PASS = process.env.EMAIL_PASS ?? '';

function createTransport() {
  if (!EMAIL_USER || !EMAIL_PASS) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
}

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
): Promise<void> {
  const resetUrl = `${APP_URL}/reset-password?token=${resetToken}`;
  const transport = createTransport();

  if (!transport) {
    console.log(`[DEV] Password reset link for ${to}:\n${resetUrl}`);
    return;
  }

  await transport.sendMail({
    from: `"KORT" <${EMAIL_USER}>`,
    to,
    subject: 'Восстановление пароля в KORT',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <h2 style="margin: 0 0 8px; font-size: 20px; color: #111;">Восстановление пароля</h2>
        <p style="margin: 0 0 24px; color: #555; font-size: 15px; line-height: 1.5;">
          Вы получили это письмо, потому что запросили смену пароля в системе KORT.<br>
          Перейдите по кнопке ниже, чтобы задать новый пароль.
        </p>
        <a href="${resetUrl}"
           style="display: inline-block; padding: 12px 24px; background: #111; color: #fff;
                  text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 500;">
          Сменить пароль
        </a>
        <p style="margin: 24px 0 0; color: #999; font-size: 13px;">
          Ссылка действительна 1 час. Если вы не запрашивали смену пароля, просто проигнорируйте это письмо.
        </p>
      </div>
    `,
  });
}
