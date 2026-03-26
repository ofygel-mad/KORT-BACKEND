/*
  Warnings:

  - A unique constraint covering the columns `[phone]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex (IF NOT EXISTS — index may already exist from previous migration)
CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_key" ON "users"("phone");
