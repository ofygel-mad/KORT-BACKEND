import { z } from 'zod';

/**
 * Login schema — accepts EITHER email OR phone (not both required).
 * Frontend sends { email, password } for email login
 * and { phone, password } for phone/employee login.
 */
export const loginSchema = z
  .object({
    email: z.string().email('Некорректный email').toLowerCase().optional(),
    phone: z.string().min(7, 'Некорректный телефон').optional(),
    password: z.string().min(1, 'Пароль не может быть пустым'),
    invite_token: z.string().optional(),
  })
  .refine((d) => d.email || d.phone, {
    message: 'Необходимо указать email или номер телефона',
  });

export const registerCompanySchema = z.object({
  full_name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(6, 'Пароль должен содержать минимум 6 символов'),
  phone: z.string().optional(),
  company_name: z.string().min(1).max(200),
});

/**
 * Set-password schema — used on POST /auth/set-password/.
 * The temp_token is extracted from the Authorization header, not the body.
 */
export const setPasswordSchema = z
  .object({
    new_password: z.string().min(6, 'Пароль должен содержать минимум 6 символов'),
    confirm_password: z.string().min(1),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: 'Пароли не совпадают',
    path: ['confirm_password'],
  });

export const refreshSchema = z.object({
  refresh: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Некорректный email'),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    new_password: z.string().min(6, 'Пароль должен содержать минимум 6 символов'),
    confirm_password: z.string().min(1),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: 'Пароли не совпадают',
    path: ['confirm_password'],
  });

/**
 * @deprecated Employees are now added exclusively by admins via /company/employees/.
 * This schema remains only for backward compat — the route returns 410 Gone.
 */
export const registerEmployeeSchema = z.object({
  full_name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  invite_token: z.string().optional(),
});
